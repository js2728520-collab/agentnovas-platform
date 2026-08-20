import { EmptyState, PageHeading } from "./page-state";

export function WorkspacePlaceholder({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <><PageHeading eyebrow={eyebrow} title={title} description={description} /><EmptyState title="模块正在接入" description="当前页面只会展示真实服务端能力，不会使用演示数据冒充业务结果。" /></>;
}
