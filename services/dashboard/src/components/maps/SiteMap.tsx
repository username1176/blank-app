/**
 * SiteMap — renders a Mapbox GL map with a marker for every site.
 *
 * The Mapbox public token is read from import.meta.env.VITE_MAPBOX_TOKEN.
 * If it is absent, the component renders a placeholder instead of erroring.
 */

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Site, SiteStatus } from "../../types";

const TOKEN = (import.meta.env["VITE_MAPBOX_TOKEN"] as string | undefined) ?? "";

const MARKER_COLOR: Record<SiteStatus, string> = {
  active:   "#22c55e",
  warning:  "#f59e0b",
  inactive: "#94a3b8",
};

interface Props {
  sites:     Site[];
  className?: string;
}

export default function SiteMap({ sites, className = "w-full h-full" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<mapboxgl.Map | null>(null);
  const markersRef   = useRef<mapboxgl.Marker[]>([]);

  // Initialise map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    if (!TOKEN) return; // handled by the no-token fallback below

    mapboxgl.accessToken = TOKEN;

    mapRef.current = new mapboxgl.Map({
      container: containerRef.current,
      style:     "mapbox://styles/mapbox/light-v11",
      center:    [0, 20],
      zoom:      1.5,
      attributionControl: false,
    });

    mapRef.current.addControl(new mapboxgl.NavigationControl(), "top-right");
    mapRef.current.addControl(
      new mapboxgl.AttributionControl({ compact: true }),
      "bottom-right",
    );

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Sync markers whenever `sites` changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Remove old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    sites.forEach((site) => {
      const el = document.createElement("div");
      el.style.cssText = `
        width: 14px; height: 14px;
        border-radius: 50%;
        background: ${MARKER_COLOR[site.status]};
        border: 2px solid white;
        box-shadow: 0 1px 4px rgba(0,0,0,.3);
        cursor: pointer;
      `;

      const popup = new mapboxgl.Popup({ offset: 10, closeButton: false })
        .setHTML(`
          <div class="text-sm">
            <p class="font-semibold text-slate-800">${site.name}</p>
            ${site.location.address ? `<p class="text-slate-500 text-xs mt-0.5">${site.location.address}</p>` : ""}
            <p class="mt-1 text-xs capitalize ${site.status === "warning" ? "text-amber-600" : site.status === "active" ? "text-green-600" : "text-slate-500"}">
              ${site.status}
            </p>
          </div>
        `);

      const marker = new mapboxgl.Marker(el)
        .setLngLat([site.location.lng, site.location.lat])
        .setPopup(popup)
        .addTo(map);

      markersRef.current.push(marker);
    });
  }, [sites]);

  if (!TOKEN) {
    return (
      <div className={`${className} flex items-center justify-center bg-slate-100 rounded-lg`}>
        <p className="text-sm text-slate-500">
          Set <code className="font-mono bg-slate-200 px-1 rounded">VITE_MAPBOX_TOKEN</code> to enable the map.
        </p>
      </div>
    );
  }

  return <div ref={containerRef} className={className} />;
}
