import type { GeoDataPoint } from '../charts/GeoChart'
import type { BubbleMapPoint } from '../charts/BubbleMapChart'

export const worldSampleData: GeoDataPoint[] = [
  { id: '392', label: '日本', value: 4500 },
  { id: '840', label: '米国', value: 8200 },
  { id: '156', label: '中国', value: 6100 },
  { id: '276', label: 'ドイツ', value: 3200 },
  { id: '826', label: '英国', value: 2800 },
  { id: '250', label: 'フランス', value: 2400 },
  { id: '356', label: 'インド', value: 3900 },
  { id: '076', label: 'ブラジル', value: 1800 },
  { id: '036', label: 'オーストラリア', value: 1400 },
  { id: '124', label: 'カナダ', value: 2100 },
  { id: '410', label: '韓国', value: 2600 },
  { id: '702', label: 'シンガポール', value: 1900 },
]

export const japanSampleData: GeoDataPoint[] = [
  { id: '13', label: '東京都', value: 2800 },
  { id: '27', label: '大阪府', value: 1500 },
  { id: '23', label: '愛知県', value: 980 },
  { id: '14', label: '神奈川県', value: 1200 },
  { id: '11', label: '埼玉県', value: 760 },
  { id: '12', label: '千葉県', value: 720 },
  { id: '28', label: '兵庫県', value: 680 },
  { id: '40', label: '福岡県', value: 590 },
  { id: '01', label: '北海道', value: 420 },
  { id: '04', label: '宮城県', value: 310 },
]

export const bubbleWorldSampleData: BubbleMapPoint[] = [
  { id: 'tokyo', label: '東京', value: 2800, lat: 35.6762, lon: 139.6503 },
  { id: 'newyork', label: 'ニューヨーク', value: 3500, lat: 40.7128, lon: -74.006 },
  { id: 'london', label: 'ロンドン', value: 2200, lat: 51.5074, lon: -0.1278 },
  { id: 'paris', label: 'パリ', value: 1800, lat: 48.8566, lon: 2.3522 },
  { id: 'beijing', label: '北京', value: 2600, lat: 39.9042, lon: 116.4074 },
  { id: 'sydney', label: 'シドニー', value: 1200, lat: -33.8688, lon: 151.2093 },
  { id: 'dubai', label: 'ドバイ', value: 1500, lat: 25.2048, lon: 55.2708 },
  { id: 'singapore', label: 'シンガポール', value: 1900, lat: 1.3521, lon: 103.8198 },
]

export const bubbleJapanSampleData: BubbleMapPoint[] = [
  { id: 'tokyo', label: '東京', value: 2800, lat: 35.6762, lon: 139.6503 },
  { id: 'osaka', label: '大阪', value: 1500, lat: 34.6937, lon: 135.5023 },
  { id: 'nagoya', label: '名古屋', value: 980, lat: 35.1815, lon: 136.9066 },
  { id: 'sapporo', label: '札幌', value: 620, lat: 43.0618, lon: 141.3545 },
  { id: 'fukuoka', label: '福岡', value: 750, lat: 33.5904, lon: 130.4017 },
  { id: 'sendai', label: '仙台', value: 410, lat: 38.2682, lon: 140.8694 },
  { id: 'hiroshima', label: '広島', value: 520, lat: 34.3853, lon: 132.4553 },
  { id: 'kyoto', label: '京都', value: 680, lat: 35.0116, lon: 135.7681 },
]
