import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface TextBoxProps {
  /** 表示テキスト。children があればそちらを優先。 */
  text?: string;
  /** 任意の子要素（リッチな内容を入れる場合） */
  children?: ReactNode;
  className?: string;
}

/**
 * 自由記述テキストを表示する箱。改行保持・折り返し・スクロール可。store 非依存。
 */
export function TextBox({ text, children, className }: TextBoxProps) {
  return (
    <div
      className={cn(
        "h-full w-full overflow-auto whitespace-pre-wrap break-words p-3 leading-relaxed",
        "text-[color:var(--foreground)]",
        className,
      )}
    >
      {children ?? text ?? "テキストを入力してください"}
    </div>
  );
}
