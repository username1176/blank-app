/**
 * MoistureChart — dual-axis line chart for moisture % and temperature (°C).
 * Built with Recharts.
 */

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MoistureReading } from "../../types";

interface ChartDatum {
  time:            string;
  moisturePercent: number;
  tempCelsius:     number;
}

function toChartData(readings: MoistureReading[]): ChartDatum[] {
  return readings.map((r) => ({
    time:            new Date(r.timestamp).toLocaleTimeString([], {
      hour:   "2-digit",
      minute: "2-digit",
    }),
    moisturePercent: Math.round(r.moisturePercent * 10) / 10,
    tempCelsius:     Math.round(r.temperatureCelsius * 10) / 10,
  }));
}

interface Props {
  readings:   MoistureReading[];
  className?: string;
}

export default function MoistureChart({ readings, className = "" }: Props) {
  const data = toChartData(readings);

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 24, left: -8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 11, fill: "#94a3b8" }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="moisture"
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fontSize: 11, fill: "#94a3b8" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            yAxisId="temp"
            orientation="right"
            tickFormatter={(v: number) => `${v}°`}
            tick={{ fontSize: 11, fill: "#94a3b8" }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={{
              fontSize:     12,
              borderRadius: 8,
              border:       "1px solid #e2e8f0",
              boxShadow:    "0 2px 8px rgba(0,0,0,.08)",
            }}
            formatter={(value: number, name: string) =>
              name === "moisturePercent"
                ? [`${value}%`, "Moisture"]
                : [`${value}°C`, "Temperature"]
            }
          />
          <Legend
            formatter={(value: string) =>
              value === "moisturePercent" ? "Moisture (%)" : "Temperature (°C)"
            }
            wrapperStyle={{ fontSize: 12 }}
          />
          <Line
            yAxisId="moisture"
            type="monotone"
            dataKey="moisturePercent"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="tempCelsius"
            stroke="#f59e0b"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
