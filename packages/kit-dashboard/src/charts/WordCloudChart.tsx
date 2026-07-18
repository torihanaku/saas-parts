import { useRef, useEffect, useState, useCallback } from "react";
import { getColorScheme } from "../lib/colorUtils";
import { cn } from "../lib/cn";

export interface WordCloudProps {
  data?: { word: string; count: number }[];
  colorScheme?: string;
  dataCategory?: string;
  onCrossFilter?: (word: string) => void;
  className?: string;
}

function getWordData(
  dataCategory?: string,
): Array<{ text: string; value: number }> {
  const sets: Record<string, Array<{ text: string; value: number }>> = {
    leads: [
      { text: "SaaS", value: 95 }, { text: "マーケティング", value: 88 },
      { text: "リード獲得", value: 82 }, { text: "コンバージョン", value: 75 },
      { text: "CRM", value: 70 }, { text: "営業", value: 65 },
      { text: "デモ", value: 58 }, { text: "顧客", value: 52 },
      { text: "オンボーディング", value: 48 }, { text: "チャーン", value: 40 },
      { text: "ARR", value: 85 }, { text: "MRR", value: 78 },
      { text: "パイプライン", value: 62 }, { text: "商談", value: 55 },
      { text: "フォローアップ", value: 45 },
    ],
    revenue: [
      { text: "売上", value: 98 }, { text: "ARR", value: 90 },
      { text: "MRR", value: 85 }, { text: "成長率", value: 78 },
      { text: "LTV", value: 72 }, { text: "CAC", value: 68 },
      { text: "利益", value: 64 }, { text: "ROI", value: 60 },
      { text: "ROAS", value: 55 }, { text: "マージン", value: 50 },
      { text: "予算", value: 45 }, { text: "収益", value: 88 },
      { text: "チャーン", value: 40 }, { text: "NRR", value: 75 },
      { text: "拡張収益", value: 58 },
    ],
    marketing: [
      { text: "コンテンツ", value: 95 }, { text: "SEO", value: 88 },
      { text: "SNS", value: 82 }, { text: "メール", value: 76 },
      { text: "キャンペーン", value: 70 }, { text: "ブランド", value: 65 },
      { text: "リターゲット", value: 60 }, { text: "インフルエンサー", value: 55 },
      { text: "ウェビナー", value: 50 }, { text: "ホワイトペーパー", value: 45 },
      { text: "PPC", value: 78 }, { text: "ABM", value: 68 },
      { text: "ランディングページ", value: 58 }, { text: "A/Bテスト", value: 48 },
      { text: "エンゲージメント", value: 85 },
    ],
  };
  return sets[dataCategory ?? "leads"] ?? sets["leads"]!;
}

interface PlacedWord {
  text: string;
  value: number;
  size: number;
  x: number;
  y: number;
  rotate: number;
  color: string;
}

function layoutWords(
  words: Array<{ text: string; value: number }>,
  width: number,
  height: number,
  colors: string[],
): PlacedWord[] {
  const maxVal = Math.max(...words.map((w) => w.value));
  const minSize = 11;
  const maxSize = 36;
  return words.map((word, i) => {
    const size = minSize + (word.value / maxVal) * (maxSize - minSize);
    // Golden angle spiral for natural cloud placement
    const angle = i * 2.39996;
    const r = Math.sqrt(i) * 22;
    const x = width / 2 + r * Math.cos(angle);
    const y = height / 2 + r * Math.sin(angle);
    // Deterministic rotation: every 3rd word rotated 90 degrees
    const rotate = i % 3 === 2 ? 90 : 0;
    const color = colors[i % colors.length]!;
    return { ...word, size, x, y, rotate, color };
  });
}

export function WordCloudChart({
  data,
  colorScheme = "blue",
  dataCategory,
  onCrossFilter,
  className,
}: WordCloudProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 400, height: 300 });
  const [hoveredWord, setHoveredWord] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const words: Array<{ text: string; value: number }> = data
    ? data.map((d) => ({ text: d.word, value: d.count }))
    : getWordData(dataCategory);

  // テーマ追従の配色（named scheme はブランドパレット、未指定はグローバル var(...) パレット）
  const colors = getColorScheme(colorScheme);
  const { width, height } = dimensions;
  const placed = layoutWords(words, width, height, colors);

  const handleClick = useCallback(
    (word: string) => {
      onCrossFilter?.(word);
    },
    [onCrossFilter],
  );

  return (
    <div
      ref={containerRef}
      className={cn("h-full w-full overflow-hidden", className)}
      aria-label="ワードクラウド"
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${width} ${height}`}
        style={{ fontFamily: "sans-serif", display: "block" }}
        role="img"
        aria-label="ワードクラウドチャート"
      >
        {placed.map((w) => (
          <text
            key={w.text}
            x={w.x}
            y={w.y}
            fontSize={w.size}
            fill={w.color}
            textAnchor="middle"
            dominantBaseline="middle"
            opacity={hoveredWord !== null && hoveredWord !== w.text ? 0.45 : 1}
            transform={
              w.rotate !== 0 ? `rotate(${w.rotate}, ${w.x}, ${w.y})` : undefined
            }
            style={{
              cursor: onCrossFilter ? "pointer" : "default",
              userSelect: "none",
              transition: "opacity 0.15s ease",
              fontWeight: w.value > 70 ? 700 : w.value > 50 ? 600 : 400,
            }}
            onMouseEnter={() => setHoveredWord(w.text)}
            onMouseLeave={() => setHoveredWord(null)}
            onClick={() => handleClick(w.text)}
            aria-label={`${w.text}: ${w.value}`}
          >
            {w.text}
          </text>
        ))}
      </svg>
    </div>
  );
}
