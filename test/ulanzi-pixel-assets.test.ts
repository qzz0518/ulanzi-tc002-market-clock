import { describe, expect, test } from "bun:test";
import { PixelCanvas } from "../src/pixel-ui.ts";
import {
  UlanziPixelAssetClient,
  extractPixelAssetDataJson,
  parseUlanziPixelAssetSource,
} from "../src/ulanzi-pixel-assets.ts";

function storedZip(name: string, contents: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const local = Buffer.alloc(30 + nameBytes.length + contents.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  Buffer.from(nameBytes).copy(local, 30);
  Buffer.from(contents).copy(local, 30 + nameBytes.length);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  Buffer.from(nameBytes).copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return new Uint8Array(Buffer.concat([local, central, end]));
}

describe("Ulanzi pixel asset adapter", () => {
  test("accepts official contentView links and rejects arbitrary download URLs", () => {
    expect(parseUlanziPixelAssetSource("1091")).toBe("1091");
    expect(parseUlanziPixelAssetSource(
      "https://ugc.ulanzistudio.com/contentView/1091?status=index&title=Castle",
    )).toBe("1091");
    expect(() => parseUlanziPixelAssetSource("https://evil.example/contentView/1091"))
      .toThrow("只支持");
    expect(() => parseUlanziPixelAssetSource("http://ugc.ulanzistudio.com/contentView/1091"))
      .toThrow("只支持");
    expect(() => parseUlanziPixelAssetSource("https://ugc.ulanzistudio.com@evil.example/contentView/1091"))
      .toThrow("只支持");
  });

  test("extracts only the root data.json entry from the official ZIP shape", () => {
    const json = new TextEncoder().encode('{"images":[]}');
    expect(new TextDecoder().decode(extractPixelAssetDataJson(storedZip("data.json", json))))
      .toBe('{"images":[]}');
    expect(() => extractPixelAssetDataJson(storedZip("../data.json", json)))
      .toThrow("entry is unsupported");
  });

  test("normalizes list fields and downloads the archive from the fixed CDN origin", async () => {
    const png = new PixelCanvas(52, 16, [0, 255, 102]).toPng();
    const dataJson = new TextEncoder().encode(JSON.stringify({
      images: [{ index: 0, base64: `data:image/png;base64,${Buffer.from(png).toString("base64")}` }],
    }));
    const archive = storedZip("data.json", dataJson);
    const requested: URL[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.pathname === "/api/api/list") {
        return Response.json({
          code: 200,
          count: 1,
          data: [{
            id: "1091",
            titleCn: "新天鹅堡",
            author: "Sakiko",
            overviewZh: "城堡",
            classify: 12,
            banner: "/cdn/uploadPath/upload/castle.png",
          }, {
            id: "1082",
            titleCn: "？",
            banner: "/profile/upload/question.png",
          }],
        });
      }
      if (url.pathname === "/api/api/resources") {
        return Response.json({
          code: 200,
          tResources: {
            id: "1091",
            cateId: "1818114700000000001",
            titleCn: "新天鹅堡",
            author: "Sakiko",
            status: 1,
            files: "/cdn/uploadPath/upload/castle.zip",
          },
        });
      }
      if (url.pathname === "/cdn/uploadPath/upload/castle.zip") {
        const body = archive.buffer.slice(
          archive.byteOffset,
          archive.byteOffset + archive.byteLength,
        ) as ArrayBuffer;
        return new Response(body, { headers: { "Content-Type": "application/zip" } });
      }
      if (url.hostname === "api.ulanzistudio.com" && url.pathname === "/profile/upload/question.png") {
        return new Response(null, {
          status: 301,
          headers: { Location: "https://api_cn.ulanzistudio.com/profile/upload/question.png" },
        });
      }
      if (url.hostname === "api_cn.ulanzistudio.com" && url.pathname === "/profile/upload/question.png") {
        const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
        return new Response(body, { headers: { "Content-Type": "image/png" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new UlanziPixelAssetClient({ fetchImpl });
    const list = await client.list({ page: 1, limit: 12, search: "城堡", classificationId: 13, sort: "new" });
    expect(list.count).toBe(1);
    expect(list.items[0]).toMatchObject({ id: "1091", title: "新天鹅堡", author: "Sakiko" });
    expect(list.items.map((item) => item.id)).toEqual(["1091", "1082"]);
    expect(requested[0]?.searchParams.get("cateId")).toBe("1818114700000000001");
    expect(requested[0]?.searchParams.get("classify")).toBe("13");

    const imported = await client.download("https://ugc.ulanzistudio.com/contentView/1091");
    expect(imported.mimeType).toBe("image/png");
    expect(imported.bytes.subarray(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(requested.at(-1)?.origin).toBe("https://api.ulanzistudio.com");

    const legacyPreview = await client.preview("/profile/upload/question.png");
    expect(legacyPreview.contentType).toBe("image/png");
    expect(requested.slice(-2).map((url) => url.hostname)).toEqual([
      "api.ulanzistudio.com",
      "api_cn.ulanzistudio.com",
    ]);
  });
});
