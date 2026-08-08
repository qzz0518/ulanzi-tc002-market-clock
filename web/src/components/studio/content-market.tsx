import { useRef, useState, type FormEvent } from "react";
import { AppWindow, Check, LoaderCircle, Plus, Search } from "lucide-react";
import { Button, Input, Select, SurfaceCut, Tab, Tabs, TabsList } from "@cladd-ui/react";
import { jsonApi } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import type {
  ContentCatalogEntry,
  ContentCategory,
  ContentCategoryEntry,
  MarketInstrument,
  MarketInstrumentKind,
  MarketSearchCandidate,
} from "@/types";
import { ContentIcon } from "./content-icon";

interface ContentMarketProps {
  categories: ContentCategoryEntry[];
  catalog: ContentCatalogEntry[];
  category: ContentCategory;
  instruments: MarketInstrument[];
  addedContentIds: readonly string[];
  addedInstrumentRefs: readonly string[];
  onCategoryChange: (category: ContentCategory) => void;
  onAdd: (definition: ContentCatalogEntry) => void;
  onStandalone: (definition: ContentCatalogEntry) => void;
  onAddInstrument: (instrument: MarketInstrument) => void;
  onStandaloneInstrument: (instrument: MarketInstrument) => void;
}

interface SearchResponse {
  results: MarketSearchCandidate[];
  notice?: string;
}

interface RegisterResponse {
  instrument: MarketInstrument;
}

const KIND_LABELS: Readonly<Record<MarketInstrumentKind, string>> = {
  crypto: "数字货币",
  fx: "汇率",
  metal: "金属",
  stock: "股票",
};

const SEARCH_KIND_OPTIONS: ("" | MarketInstrumentKind)[] = [
  "",
  "crypto",
  "fx",
  "metal",
  "stock",
];

function searchKindLabel(kind: "" | MarketInstrumentKind): string {
  return kind ? KIND_LABELS[kind] : "全部类型";
}

export function ContentMarket({
  categories,
  catalog,
  category,
  instruments,
  addedContentIds,
  addedInstrumentRefs,
  onCategoryChange,
  onAdd,
  onStandalone,
  onAddInstrument,
  onStandaloneInstrument,
}: ContentMarketProps) {
  const contents = catalog.filter((item) => item.category === category && item.availableInMarket !== false);
  const added = new Set(addedContentIds);
  const addedRefs = new Set(addedInstrumentRefs);
  const registeredByCanonical = new Map(instruments.map((instrument) => [instrument.canonicalKey, instrument]));
  const [query, setQuery] = useState("");
  const [searchKind, setSearchKind] = useState<"" | MarketInstrumentKind>("");
  const [results, setResults] = useState<MarketSearchCandidate[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [registering, setRegistering] = useState<string | null>(null);
  const searchSequence = useRef(0);

  const searchMarkets = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized) return;
    const sequence = ++searchSequence.current;
    setSearching(true);
    setNotice(null);
    try {
      const parameters = new URLSearchParams({ q: normalized });
      if (searchKind) parameters.set("kind", searchKind);
      const response = await jsonApi<SearchResponse>(`/api/market/search?${parameters}`);
      if (sequence !== searchSequence.current) return;
      setResults(response.results);
      setNotice(response.notice ?? (response.results.length === 0 ? "没有找到可添加的资产。" : null));
    } catch (error) {
      if (sequence !== searchSequence.current) return;
      setResults([]);
      setNotice(errorMessage(error));
    } finally {
      if (sequence === searchSequence.current) setSearching(false);
    }
  };

  const register = async (candidate: MarketSearchCandidate, standalone: boolean) => {
    const action = `${standalone ? "standalone" : "add"}:${candidate.candidateRef}`;
    setRegistering(action);
    setNotice(null);
    try {
      const known = registeredByCanonical.get(candidate.canonicalKey);
      const instrument = known ?? (await jsonApi<RegisterResponse>("/api/market/instruments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateRef: candidate.candidateRef }),
      })).instrument;
      if (standalone) onStandaloneInstrument(instrument);
      else onAddInstrument(instrument);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setRegistering(null);
    }
  };

  return (
    <aside className="content-market" aria-labelledby="market-title">
      <div className="market-heading">
        <h2 id="market-title">内容市场</h2>
        <span>当前分类 {contents.length} 项</span>
      </div>
      <Tabs value={category} onValueChange={(value) => onCategoryChange(value as ContentCategory)}>
        <SurfaceCut className="market-filter" color="neutral" outline={false} contentClassName="market-filter__content">
          <TabsList
            className="market-tabs"
            aria-label="内容分类"
            size="sm"
            rounded
            activeColor="brand"
            activeVariant="solid-fill"
            activeOutline={false}
          >
            {categories.map((entry) => (
              <Tab key={entry.id} value={entry.id}>{entry.label}</Tab>
            ))}
          </TabsList>
        </SurfaceCut>
      </Tabs>
      <div className="market-scroll">
        {category === "market" && (
          <section className="instrument-search" aria-labelledby="instrument-search-title">
            <div className="instrument-search__copy">
              <h3 id="instrument-search-title">搜索更多资产</h3>
              <p>零 Key 支持 Coinbase 数字货币、Frankfurter 汇率、金属与 Yahoo Finance 股票/ETF。</p>
            </div>
            <form className="instrument-search__form" onSubmit={(event) => void searchMarkets(event)}>
              <Input
                inputId="market-instrument-search"
                className="instrument-search__input"
                inputClassName="instrument-search__input-control"
                size="sm"
                color="neutral"
                icon={<Search aria-hidden="true" />}
                value={query}
                maxLength={48}
                placeholder="BTC、TSLA、EUR/USD、Silver…"
                inputMode="search"
                inputComponentProps={{
                  "aria-label": "资产名称或代码",
                  autoCapitalize: "characters",
                  spellCheck: false,
                }}
                onChange={(nextValue) => {
                  searchSequence.current += 1;
                  setSearching(false);
                  setQuery(nextValue);
                }}
              />
              <Select<"" | MarketInstrumentKind>
                className="instrument-search__kind"
                aria-label="资产类型"
                size="sm"
                color="neutral"
                value={searchKind}
                options={SEARCH_KIND_OPTIONS}
                noneOptionValue=""
                renderOption={({ value }) => searchKindLabel(value)}
                onChange={(nextValue) => {
                  searchSequence.current += 1;
                  setSearching(false);
                  setSearchKind(nextValue);
                }}
              >
                {searchKindLabel(searchKind)}
              </Select>
              <Button type="submit" size="sm" disabled={searching || !query.trim()}>
                {searching ? <LoaderCircle className="is-spinning" /> : <Search />}
                {searching ? "搜索中" : "搜索"}
              </Button>
            </form>
            {notice && <p className="instrument-search__notice" role="status">{notice}</p>}
            {results.length > 0 && (
              <div className="instrument-results" aria-label="资产搜索结果">
                {results.map((candidate) => {
                  const known = registeredByCanonical.get(candidate.canonicalKey);
                  const inChannel = known ? addedRefs.has(known.ref) : false;
                  const adding = registering === `add:${candidate.candidateRef}`;
                  const creating = registering === `standalone:${candidate.candidateRef}`;
                  return (
                    <article key={candidate.candidateRef} className={inChannel ? "market-item is-added" : "market-item"}>
                      <div className="market-item__title">
                        <ContentIcon
                          contentId="market:instrument"
                          compact
                          iconUrl={known?.iconUrl}
                          fallbackLabel={candidate.baseCode}
                        />
                        <div className="instrument-result__identity">
                          <h3>{candidate.pair}</h3>
                          <span>{KIND_LABELS[candidate.kind]} · {candidate.sourceLabel}</span>
                        </div>
                        {inChannel && <span className="market-added"><Check />已在频道中</span>}
                      </div>
                      <p>{candidate.displayName}<br />{candidate.sourceNote}</p>
                      <div className="market-actions">
                        <Button
                          type="button"
                          size="sm"
                          disabled={inChannel || registering !== null}
                          onClick={() => void register(candidate, false)}
                        >
                          {adding ? <LoaderCircle className="is-spinning" /> : inChannel ? <Check /> : <Plus />}
                          {adding ? "添加中" : inChannel ? "已添加" : "加入频道"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={registering !== null}
                          onClick={() => void register(candidate, true)}
                        >
                          {creating ? <LoaderCircle className="is-spinning" /> : <AppWindow />}
                          {creating ? "创建中" : "设为独立 App"}
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}
        <div className="market-list">
          {contents.map((item) => {
            const inChannel = added.has(item.id);
            return (
              <article key={item.id} className={inChannel ? "market-item is-added" : "market-item"}>
                <div className="market-item__title">
                  <ContentIcon contentId={item.id} compact />
                  <h3>{item.title}</h3>
                  {inChannel && <span className="market-added"><Check />已在频道中</span>}
                </div>
                <p>{item.description}</p>
                <div className="market-actions">
                  <Button type="button" size="sm" disabled={inChannel} onClick={() => onAdd(item)}>
                    {inChannel ? <Check /> : <Plus />}{inChannel ? "已添加" : "加入频道"}
                  </Button>
                  <Button type="button" size="sm" onClick={() => onStandalone(item)}><AppWindow />设为独立 App</Button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
