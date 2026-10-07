// Tree-shaken ECharts build: only the chart types and components the dashboard uses.
import { BarChart, CustomChart, EffectScatterChart, GraphChart, HeatmapChart, LineChart, LinesChart, PieChart, SankeyChart, ScatterChart, TreemapChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  CustomChart,
  EffectScatterChart,
  GraphChart,
  LinesChart,
  LineChart,
  HeatmapChart,
  PieChart,
  SankeyChart,
 
 
 
  ScatterChart,
  TreemapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  MarkAreaComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

export { echarts };
export type EChartsOption = echarts.EChartsCoreOption;
