"""
Warehouse Materials Intelligence Platform — Streamlit Dashboard
Multi-tenant monitoring for bulk materials (inventory, moisture, environment, alerts).
"""

import streamlit as st
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import random

# ─────────────────────────────────────────────────────────────────────────────
# Page config
# ─────────────────────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="Warehouse Materials Intelligence",
    page_icon="🏭",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ─────────────────────────────────────────────────────────────────────────────
# Synthetic data generators (replace with DB queries in production)
# ─────────────────────────────────────────────────────────────────────────────
CUSTOMERS = {
    "Acme Minerals": "cust-001",
    "BlueRidge Cement": "cust-002",
    "FertilGrow Corp": "cust-003",
}

SITES = {
    "cust-001": ["Acme - Warehouse A", "Acme - Warehouse B"],
    "cust-002": ["BlueRidge - Main Plant", "BlueRidge - Storage Lot"],
    "cust-003": ["FertilGrow - North Depot"],
}

PILES = {
    "Acme - Warehouse A":     [("Pile-A1", "aluminum_trihydrate"), ("Pile-A2", "aluminum_trihydrate"), ("Pile-A3", "bauxite")],
    "Acme - Warehouse B":     [("Pile-B1", "aluminum_trihydrate"), ("Pile-B2", "coal")],
    "BlueRidge - Main Plant": [("Silo-1", "cement"), ("Silo-2", "cement"), ("Pile-C1", "limestone")],
    "BlueRidge - Storage Lot":[("Stack-1", "cement"), ("Stack-2", "gypsum")],
    "FertilGrow - North Depot":[("Fert-1", "fertilizer"), ("Fert-2", "fertilizer"), ("Fert-3", "urea")],
}

MATERIAL_DENSITY = {
    "aluminum_trihydrate": 2.42,
    "bauxite": 2.55,
    "cement": 1.50,
    "limestone": 2.71,
    "gypsum": 2.32,
    "coal": 0.85,
    "fertilizer": 1.05,
    "urea": 1.32,
}

ALERT_TYPES = [
    "inventory_drop", "inventory_discrepancy",
    "moisture_high", "moisture_low",
    "temperature_anomaly", "humidity_anomaly",
    "camera_offline", "sensor_offline",
]

SENSORS_PER_SITE = {site: [f"SENSOR-{site[:3].upper()}-{i:02d}" for i in range(1, 5)]
                   for site in sum(SITES.values(), [])}


def _seed(name: str) -> int:
    return sum(ord(c) for c in name) % 9999


def gen_inventory_history(pile_name: str, material: str, days: int = 30) -> pd.DataFrame:
    np.random.seed(_seed(pile_name))
    n = days * 24
    base_vol = np.random.uniform(800, 5000)
    volumes = np.clip(base_vol + np.cumsum(np.random.normal(0, 30, n)), 50, base_vol * 1.5)
    density = MATERIAL_DENSITY.get(material, 1.5)
    times = [datetime.utcnow() - timedelta(hours=n - i) for i in range(n)]
    return pd.DataFrame({
        "time": times,
        "volume_m3": volumes,
        "estimated_tonnes": volumes * density,
        "height_m": (volumes / (np.pi * 15 ** 2)) ** (1 / 3) * 2,
        "confidence_score": np.clip(np.random.normal(0.92, 0.04, n), 0.5, 1.0),
    })


def gen_moisture_history(pile_name: str, days: int = 30) -> pd.DataFrame:
    np.random.seed(_seed(pile_name) + 1)
    n = days * 24
    base = np.random.uniform(3.0, 12.0)
    moisture = np.clip(base + np.cumsum(np.random.normal(0, 0.15, n)), 0, 35)

    def classify(m):
        if m < 5:
            return "dry"
        elif m < 15:
            return "normal"
        return "wet"

    times = [datetime.utcnow() - timedelta(hours=n - i) for i in range(n)]
    return pd.DataFrame({
        "time": times,
        "moisture_pct": moisture,
        "zone_classification": [classify(m) for m in moisture],
        "confidence_score": np.clip(np.random.normal(0.88, 0.05, n), 0.5, 1.0),
    })


def gen_sensor_history(site_name: str, sensor_id: str, days: int = 7) -> pd.DataFrame:
    np.random.seed(_seed(site_name + sensor_id))
    n = days * 48
    base_temp = np.random.uniform(18, 28)
    base_hum = np.random.uniform(40, 70)
    temp = np.clip(base_temp + np.cumsum(np.random.normal(0, 0.3, n)), -5, 45)
    hum = np.clip(base_hum + np.cumsum(np.random.normal(0, 0.5, n)), 10, 100)
    times = [datetime.utcnow() - timedelta(minutes=30 * (n - i)) for i in range(n)]
    return pd.DataFrame({"time": times, "temperature_c": temp, "humidity_pct": hum})


def gen_alerts(customer_id: str, n: int = 40) -> pd.DataFrame:
    random.seed(_seed(customer_id))
    rows = []
    for i in range(n):
        atype = random.choice(ALERT_TYPES)
        sev = random.choices(["info", "warning", "critical"], weights=[4, 4, 2])[0]
        acked = random.random() > 0.4
        created = datetime.utcnow() - timedelta(hours=random.randint(0, 72))
        rows.append({
            "id": f"alert-{i:04d}",
            "alert_type": atype,
            "severity": sev,
            "message": _alert_message(atype, sev),
            "acknowledged": acked,
            "acknowledged_at": created + timedelta(minutes=random.randint(5, 120)) if acked else None,
            "created_at": created,
        })
    return pd.DataFrame(rows).sort_values("created_at", ascending=False).reset_index(drop=True)


def _alert_message(atype: str, sev: str) -> str:
    return {
        "inventory_drop":        f"Pile volume dropped >15% in the last hour ({sev})",
        "inventory_discrepancy": f"Reactor intake vs. camera volume mismatch >5% ({sev})",
        "moisture_high":         f"Moisture exceeded wet-zone threshold ({sev})",
        "moisture_low":          f"Moisture below dry-zone minimum — desiccant check required ({sev})",
        "temperature_anomaly":   f"Temperature deviation >3σ from 30-day baseline ({sev})",
        "humidity_anomaly":      f"Humidity spike detected in storage zone ({sev})",
        "camera_offline":        f"Thermal camera did not report for >15 min ({sev})",
        "sensor_offline":        f"Environmental sensor unresponsive for >30 min ({sev})",
    }.get(atype, "Unknown alert")


SEV_COLOR  = {"info": "🔵", "warning": "🟡", "critical": "🔴"}
ZONE_COLOR = {"dry": "🟠", "normal": "🟢", "wet": "🔵"}


# ─────────────────────────────────────────────────────────────────────────────
# Sidebar — tenant & navigation
# ─────────────────────────────────────────────────────────────────────────────
with st.sidebar:
    st.title("🏭 WMI Platform")
    st.caption("Warehouse Materials Intelligence")
    st.divider()

    customer_name = st.selectbox("Customer", list(CUSTOMERS.keys()))
    customer_id = CUSTOMERS[customer_name]

    site_list = SITES[customer_id]
    selected_site = st.selectbox("Site", site_list)

    st.divider()
    page = st.radio(
        "Navigation",
        ["Overview", "Inventory", "Moisture", "Environment", "Alerts", "Settings"],
        label_visibility="collapsed",
    )
    st.divider()
    st.caption(f"Tenant: `{customer_id}`")
    st.caption(f"UTC: {datetime.utcnow().strftime('%Y-%m-%d %H:%M')}")


def pile_selector(site: str):
    piles = PILES.get(site, [])
    pile_names = [p[0] for p in piles]
    sel = st.selectbox("Pile", pile_names)
    material = next(p[1] for p in piles if p[0] == sel)
    return sel, material


# ─────────────────────────────────────────────────────────────────────────────
# PAGE: Overview
# ─────────────────────────────────────────────────────────────────────────────
if page == "Overview":
    st.title(f"Overview — {customer_name}")
    st.caption(f"Site: {selected_site}")

    piles = PILES.get(selected_site, [])

    total_tonnes, wet_piles = 0.0, 0
    for pname, mat in piles:
        total_tonnes += float(gen_inventory_history(pname, mat, days=1)["estimated_tonnes"].iloc[-1])
        if gen_moisture_history(pname, days=1)["zone_classification"].iloc[-1] == "wet":
            wet_piles += 1

    alerts_df = gen_alerts(customer_id)
    unacked  = int((~alerts_df["acknowledged"]).sum())
    critical = int((alerts_df["severity"] == "critical").sum())

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total Inventory", f"{total_tonnes:,.0f} t")
    c2.metric("Active Piles", len(piles))
    c3.metric("Wet-Zone Piles", wet_piles,
              delta=wet_piles if wet_piles else None, delta_color="inverse" if wet_piles else "off")
    c4.metric("Unacknowledged Alerts", unacked,
              delta=f"{critical} critical" if critical else None,
              delta_color="inverse" if critical else "off")

    st.divider()
    st.subheader("Pile Status")
    rows = []
    for pname, mat in piles:
        inv   = gen_inventory_history(pname, mat, days=2).iloc[-1]
        moist = gen_moisture_history(pname, days=1).iloc[-1]
        zone  = moist["zone_classification"]
        rows.append({
            "Pile":         pname,
            "Material":     mat.replace("_", " ").title(),
            "Volume (m³)":  f"{inv['volume_m3']:,.1f}",
            "Tonnes":       f"{inv['estimated_tonnes']:,.1f}",
            "Moisture %":   f"{moist['moisture_pct']:.2f}",
            "Zone":         f"{ZONE_COLOR[zone]} {zone}",
            "Confidence":   f"{inv['confidence_score']:.2f}",
        })
    st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

    st.divider()
    st.subheader("Recent Alerts (last 24 h)")
    recent = alerts_df[alerts_df["created_at"] >= datetime.utcnow() - timedelta(hours=24)].head(10)
    if recent.empty:
        st.info("No alerts in the last 24 hours.")
    else:
        for _, row in recent.iterrows():
            icon = SEV_COLOR.get(row["severity"], "⚪")
            ack  = "✅" if row["acknowledged"] else "⏳"
            st.markdown(
                f"{icon} **{row['alert_type'].replace('_', ' ').title()}** — "
                f"{row['message']} | {ack} | `{row['created_at'].strftime('%H:%M UTC')}`"
            )


# ─────────────────────────────────────────────────────────────────────────────
# PAGE: Inventory
# ─────────────────────────────────────────────────────────────────────────────
elif page == "Inventory":
    st.title("Inventory Tracking")
    st.caption(f"{customer_name} — {selected_site}")

    col_left, col_right = st.columns([1, 3])
    with col_left:
        selected_pile, material = pile_selector(selected_site)
        days = st.slider("History (days)", 1, 30, 7)

    df     = gen_inventory_history(selected_pile, material, days=days)
    latest = df.iloc[-1]
    prev   = df.iloc[-25] if len(df) > 24 else df.iloc[0]
    delta_t = latest["estimated_tonnes"] - prev["estimated_tonnes"]

    with col_right:
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Current Volume",    f"{latest['volume_m3']:,.1f} m³")
        m2.metric("Estimated Tonnes",  f"{latest['estimated_tonnes']:,.1f} t",
                  delta=f"{delta_t:+.1f} t (24 h)")
        m3.metric("Peak Height",       f"{latest['height_m']:.2f} m")
        m4.metric("Confidence",        f"{latest['confidence_score']:.2%}")

    st.subheader(f"Volume History — {selected_pile}")
    tab1, tab2 = st.tabs(["Volume (m³)", "Estimated Tonnes"])
    with tab1:
        st.line_chart(df.set_index("time")[["volume_m3"]])
    with tab2:
        st.line_chart(df.set_index("time")[["estimated_tonnes"]])

    st.divider()
    st.subheader("Raw Snapshots (latest 48)")
    disp = df.copy()
    disp["time"]             = disp["time"].dt.strftime("%Y-%m-%d %H:%M")
    disp["volume_m3"]        = disp["volume_m3"].round(2)
    disp["estimated_tonnes"] = disp["estimated_tonnes"].round(2)
    disp["height_m"]         = disp["height_m"].round(3)
    disp["confidence_score"] = disp["confidence_score"].round(3)
    st.dataframe(disp.sort_values("time", ascending=False).head(48),
                 use_container_width=True, hide_index=True)


# ─────────────────────────────────────────────────────────────────────────────
# PAGE: Moisture
# ─────────────────────────────────────────────────────────────────────────────
elif page == "Moisture":
    st.title("Moisture Monitoring")
    st.caption(f"{customer_name} — {selected_site}")

    col_left, col_right = st.columns([1, 3])
    with col_left:
        selected_pile, _ = pile_selector(selected_site)
        days = st.slider("History (days)", 1, 30, 7)

    df     = gen_moisture_history(selected_pile, days=days)
    latest = df.iloc[-1]
    zone   = latest["zone_classification"]

    with col_right:
        m1, m2, m3 = st.columns(3)
        m1.metric("Current Moisture",    f"{latest['moisture_pct']:.2f} %")
        m2.metric("Zone Classification", f"{ZONE_COLOR[zone]} {zone.title()}")
        m3.metric("Model Confidence",    f"{latest['confidence_score']:.2%}")

    st.subheader(f"Moisture History — {selected_pile}")
    tab1, tab2 = st.tabs(["Time Series", "Zone Distribution"])
    with tab1:
        st.line_chart(df.set_index("time")[["moisture_pct"]])
        st.caption("Dry < 5 % | Normal 5–15 % | Wet > 15 %")
    with tab2:
        zone_counts = df["zone_classification"].value_counts().reset_index()
        zone_counts.columns = ["Zone", "Count"]
        st.bar_chart(zone_counts.set_index("Zone"))

    st.divider()
    st.subheader("All Piles — Latest Moisture")
    rows = []
    for pname, mat in PILES.get(selected_site, []):
        m = gen_moisture_history(pname, days=1).iloc[-1]
        z = m["zone_classification"]
        rows.append({
            "Pile":       pname,
            "Material":   mat.replace("_", " ").title(),
            "Moisture %": round(float(m["moisture_pct"]), 3),
            "Zone":       f"{ZONE_COLOR[z]} {z}",
            "Confidence": round(float(m["confidence_score"]), 3),
        })
    st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)


# ─────────────────────────────────────────────────────────────────────────────
# PAGE: Environment
# ─────────────────────────────────────────────────────────────────────────────
elif page == "Environment":
    st.title("Environmental Monitoring")
    st.caption(f"{customer_name} — {selected_site}")

    col_left, col_right = st.columns([1, 3])
    with col_left:
        sensors         = SENSORS_PER_SITE.get(selected_site, ["SENSOR-01"])
        selected_sensor = st.selectbox("Sensor", sensors)
        days            = st.slider("History (days)", 1, 14, 3)

    df     = gen_sensor_history(selected_site, selected_sensor, days=days)
    latest = df.iloc[-1]

    temp_mean, temp_std = df["temperature_c"].mean(), df["temperature_c"].std()
    hum_mean,  hum_std  = df["humidity_pct"].mean(),  df["humidity_pct"].std()
    temp_anomaly = abs(latest["temperature_c"] - temp_mean) > 2 * temp_std
    hum_anomaly  = abs(latest["humidity_pct"]  - hum_mean)  > 2 * hum_std

    with col_right:
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Temperature", f"{latest['temperature_c']:.1f} °C",
                  delta="⚠️ Anomaly" if temp_anomaly else None,
                  delta_color="inverse" if temp_anomaly else "off")
        m2.metric("Humidity", f"{latest['humidity_pct']:.1f} %",
                  delta="⚠️ Anomaly" if hum_anomaly else None,
                  delta_color="inverse" if hum_anomaly else "off")
        m3.metric("Temp Baseline", f"{temp_mean:.1f} °C ± {temp_std:.1f}")
        m4.metric("Hum Baseline",  f"{hum_mean:.1f} % ± {hum_std:.1f}")

    st.subheader(f"Sensor History — {selected_sensor}")
    tab1, tab2, tab3 = st.tabs(["Temperature (°C)", "Humidity (%)", "Combined"])
    with tab1:
        st.line_chart(df.set_index("time")[["temperature_c"]])
    with tab2:
        st.line_chart(df.set_index("time")[["humidity_pct"]])
    with tab3:
        st.line_chart(df.set_index("time")[["temperature_c", "humidity_pct"]])

    st.divider()
    st.subheader("All Sensors — Current Readings")
    rows = []
    for sid in sensors:
        s = gen_sensor_history(selected_site, sid, days=1).iloc[-1]
        rows.append({
            "Sensor":           sid,
            "Temperature (°C)": round(float(s["temperature_c"]), 1),
            "Humidity (%)":     round(float(s["humidity_pct"]),   1),
        })
    st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)


# ─────────────────────────────────────────────────────────────────────────────
# PAGE: Alerts
# ─────────────────────────────────────────────────────────────────────────────
elif page == "Alerts":
    st.title("Alert Management")
    st.caption(customer_name)

    alerts_df = gen_alerts(customer_id, n=40)

    col1, col2, col3 = st.columns(3)
    with col1:
        sev_filter  = st.multiselect("Severity", ["info", "warning", "critical"],
                                     default=["warning", "critical"])
    with col2:
        type_filter = st.multiselect("Alert Type", ALERT_TYPES, default=[])
    with col3:
        ack_filter  = st.selectbox("Acknowledgement", ["All", "Unacknowledged", "Acknowledged"])

    filtered = alerts_df.copy()
    if sev_filter:
        filtered = filtered[filtered["severity"].isin(sev_filter)]
    if type_filter:
        filtered = filtered[filtered["alert_type"].isin(type_filter)]
    if ack_filter == "Unacknowledged":
        filtered = filtered[~filtered["acknowledged"]]
    elif ack_filter == "Acknowledged":
        filtered = filtered[filtered["acknowledged"]]

    k1, k2, k3 = st.columns(3)
    k1.metric("Showing",         len(filtered))
    k2.metric("Critical",        int((filtered["severity"] == "critical").sum()))
    k3.metric("Unacknowledged",  int((~filtered["acknowledged"]).sum()))

    st.divider()
    for _, row in filtered.iterrows():
        icon = SEV_COLOR.get(row["severity"], "⚪")
        ack  = "✅" if row["acknowledged"] else "⏳"
        with st.expander(
            f"{icon} {row['alert_type'].replace('_', ' ').title()} — "
            f"{row['created_at'].strftime('%Y-%m-%d %H:%M UTC')} {ack}"
        ):
            st.markdown(f"**Message:** {row['message']}")
            st.markdown(f"**Severity:** {row['severity'].title()}")
            st.markdown(f"**Alert ID:** `{row['id']}`")
            if row["acknowledged"]:
                st.markdown(f"**Acknowledged at:** {row['acknowledged_at']}")
            else:
                if st.button("Mark as Acknowledged", key=row["id"]):
                    st.success("Acknowledged (demo — not persisted)")

    st.divider()
    st.subheader("Alert Volume by Type")
    type_counts = alerts_df["alert_type"].value_counts().reset_index()
    type_counts.columns = ["Alert Type", "Count"]
    st.bar_chart(type_counts.set_index("Alert Type"))


# ─────────────────────────────────────────────────────────────────────────────
# PAGE: Settings (Notification Preferences)
# ─────────────────────────────────────────────────────────────────────────────
elif page == "Settings":
    st.title("Notification Preferences")
    st.caption(customer_name)

    st.info(
        "Changes here update the `notification_preferences` table. "
        "Demo mode — values are not persisted."
    )

    st.subheader("Default Delivery Settings")
    c1, c2 = st.columns(2)
    with c1:
        email_enabled = st.toggle("Email Notifications", value=True)
        if email_enabled:
            emails = st.text_area("Email Addresses (one per line)",
                                  value="ops@example.com\nalerts@example.com")
    with c2:
        sms_enabled = st.toggle("SMS Notifications", value=False)
        if sms_enabled:
            phones = st.text_area("Phone Numbers (E.164, one per line)", value="+12025550101")

    st.divider()
    st.subheader("Per-Alert-Type Rules")
    pref_rows = []
    for atype in ALERT_TYPES:
        with st.expander(atype.replace("_", " ").title()):
            c1, c2, c3 = st.columns(3)
            threshold = c1.selectbox("Severity Threshold",
                                     ["info", "warning", "critical"], index=1,
                                     key=f"thresh_{atype}")
            email_t = c2.toggle("Email", value=True,  key=f"email_{atype}")
            sms_t   = c3.toggle("SMS",   value=False, key=f"sms_{atype}")
            pref_rows.append({
                "Alert Type": atype.replace("_", " ").title(),
                "Threshold":  threshold,
                "Email":      "✅" if email_t else "—",
                "SMS":        "✅" if sms_t   else "—",
            })

    st.divider()
    st.subheader("Quiet Hours")
    c1, c2 = st.columns(2)
    quiet_start = c1.time_input("Start (site local time)", value=None)
    quiet_end   = c2.time_input("End (site local time)",   value=None)
    if quiet_start and quiet_end:
        st.caption(f"Notifications suppressed between {quiet_start} and {quiet_end}")

    st.divider()
    if st.button("Save Preferences", type="primary"):
        st.success("Preferences saved.")
        st.json({
            "customer_id":         customer_id,
            "email_enabled":       email_enabled,
            "sms_enabled":         sms_enabled,
            "quiet_hours_start":   str(quiet_start) if quiet_start else None,
            "quiet_hours_end":     str(quiet_end)   if quiet_end   else None,
            "per_type_rules":      pref_rows,
        })
