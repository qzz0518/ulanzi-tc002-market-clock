import { AppWindow, Check, Plus } from "lucide-react";
import { Button, SurfaceCut, Tab, Tabs, TabsList } from "@cladd-ui/react";
import type { ContentCatalogEntry, ContentCategory, ContentCategoryEntry } from "@/types";
import { ContentIcon } from "./content-icon";

interface ContentMarketProps {
  categories: ContentCategoryEntry[];
  catalog: ContentCatalogEntry[];
  category: ContentCategory;
  addedContentIds: readonly string[];
  onCategoryChange: (category: ContentCategory) => void;
  onAdd: (definition: ContentCatalogEntry) => void;
  onStandalone: (definition: ContentCatalogEntry) => void;
}

export function ContentMarket({
  categories,
  catalog,
  category,
  addedContentIds,
  onCategoryChange,
  onAdd,
  onStandalone,
}: ContentMarketProps) {
  const contents = catalog.filter((item) => item.category === category && item.availableInMarket !== false);
  const added = new Set(addedContentIds);

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
