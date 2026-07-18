import { useMemo } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

interface Props {
  data: unknown;
}

type Row = Record<string, unknown>;

/** Try to parse raw string as JSON, return null on failure */
export function tryParseChartData(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

/** Flatten nested Mixpanel-style { data: { values: { series: { date: val } } } } into rows */
function flattenMixpanelValues(obj: Record<string, unknown>): Row[] | null {
  const values = (obj.data as any)?.values ?? obj.values ?? obj.series;
  if (!values || typeof values !== 'object') return null;

  const seriesMap = values as Record<string, Record<string, number>>;
  const seriesNames = Object.keys(seriesMap);
  if (seriesNames.length === 0) return null;

  const firstSeries = seriesMap[seriesNames[0]];
  if (!firstSeries || typeof firstSeries !== 'object') return null;

  const labels = Object.keys(firstSeries);
  return labels.map((label) => {
    const row: Row = { label };
    for (const name of seriesNames) row[name] = seriesMap[name]?.[label] ?? 0;
    return row;
  });
}

/** Detect MCP spool metadata: { file, type|count|childCount, sizeBytes, preview } */
function isSpoolMeta(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  return 'file' in obj && 'sizeBytes' in obj;
}

/** Normalize any JSON shape into an array of flat row objects */
function normalizeToRows(data: unknown): Row[] | null {
  if (isSpoolMeta(data)) return null;
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    if (typeof data[0] === 'object' && data[0] !== null) return data as Row[];
    return null;
  }
  if (typeof data === 'object' && data !== null) {
    const nested = flattenMixpanelValues(data as Record<string, unknown>);
    if (nested) return nested;
  }
  return null;
}

type ChartType = 'bar' | 'line' | 'pie' | 'table';

function detectChartType(rows: Row[], labelKey: string, numericKeys: string[]): ChartType {
  if (numericKeys.length === 0) return 'table';
  if (numericKeys.length === 1 && rows.length <= 8) return 'pie';
  const labels = rows.map((r) => String(r[labelKey] ?? ''));
  const looksTimeSeries = labels.some((l) => /^\d{4}-\d{2}/.test(l));
  if (looksTimeSeries) return 'line';
  return rows.length > 20 ? 'line' : 'bar';
}

function classifyKeys(rows: Row[]) {
  const allKeys = [...new Set(rows.flatMap(Object.keys))];
  const numericKeys: string[] = [];
  let labelKey = '';

  for (const key of allKeys) {
    const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
    const numCount = vals.filter((v) => typeof v === 'number').length;
    if (numCount > vals.length * 0.5) numericKeys.push(key);
    else if (!labelKey) labelKey = key;
  }
  if (!labelKey) labelKey = allKeys[0] ?? 'label';
  return { labelKey, numericKeys };
}

export function SmartChart({ data }: Props) {
  const { rows, labelKey, numericKeys, chartType } = useMemo(() => {
    const rows = normalizeToRows(data);
    if (!rows || rows.length === 0) return { rows: null, labelKey: '', numericKeys: [] as string[], chartType: 'table' as ChartType };
    const { labelKey, numericKeys } = classifyKeys(rows);
    const chartType = detectChartType(rows, labelKey, numericKeys);
    return { rows, labelKey, numericKeys, chartType };
  }, [data]);

  if (!rows) return <pre className="text-xs whitespace-pre-wrap break-words">{JSON.stringify(data, null, 2)}</pre>;

  if (chartType === 'table') return <DataTable rows={rows} />;

  return (
    <div className="space-y-2">
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === 'pie' ? (
            <PieChart>
              <Pie data={rows} dataKey={numericKeys[0]} nameKey={labelKey} cx="50%" cy="50%" outerRadius={80} label>
                {rows.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          ) : chartType === 'line' ? (
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey={labelKey} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              {numericKeys.length > 1 && <Legend />}
              {numericKeys.map((key, i) => (
                <Line key={key} type="monotone" dataKey={key} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          ) : (
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey={labelKey} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              {numericKeys.length > 1 && <Legend />}
              {numericKeys.map((key, i) => (
                <Bar key={key} dataKey={key} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      <DataTable rows={rows} />
    </div>
  );
}

function DataTable({ rows }: { rows: Row[] }) {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  return (
    <div className="overflow-auto max-h-96 rounded border text-xs">
      <table className="w-full text-left">
        <thead className="bg-muted sticky top-0">
          <tr>{keys.map((k) => <th key={k} className="px-2 py-1 font-medium">{k}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t">
              {keys.map((k) => {
                const v = row[k];
                const cell = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
                return <td key={k} className="px-2 py-1 max-w-[400px] whitespace-pre-wrap break-words align-top" title={cell}>{cell}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
