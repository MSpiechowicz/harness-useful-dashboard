// Tree-shaken ECharts build: only the chart types and components the dashboard uses.
import { BarChart, HeatmapChart, LineChart } from "echarts/charts";
import {
  CalendarComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  CalendarComponent,
  DataZoomComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

export { echarts };
export type EChartsOption = echarts.EChartsCoreOption;
