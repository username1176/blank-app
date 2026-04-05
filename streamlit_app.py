import streamlit as st
import pandas as pd
import requests
from datetime import datetime, timedelta, timezone

st.set_page_config(page_title="CannaOps Management Suite", page_icon="🌿", layout="wide", initial_sidebar_state="expanded")

# ─── CUSTOM STYLING ──────────────────────────────────────────────────────────
st.markdown("""
<style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

    html, body, [class*="css"] { font-family: 'Inter', sans-serif; }

    /* Page background */
    .stApp { background: #0a0c0f; }
    .main .block-container { padding-top: 2rem; padding-bottom: 4rem; max-width: 1400px; }

    /* Hide default chrome but keep the header bar transparent so sidebar toggle stays */
    #MainMenu, footer { visibility: hidden; }
    header[data-testid="stHeader"] { background: transparent; height: 0; }
    /* Ensure sidebar expand arrow is always visible */
    [data-testid="collapsedControl"] { display: block !important; visibility: visible !important; }
    button[kind="header"] { visibility: visible !important; }

    /* Sidebar */
    [data-testid="stSidebar"] { background: #0d1014; border-right: 1px solid #1e2430; }
    [data-testid="stSidebar"] > div:first-child { padding-top: 1.5rem; }

    /* Sidebar nav buttons */
    [data-testid="stSidebar"] .stButton > button {
        background: transparent; color: #8a96b0; border: 1px solid transparent;
        text-align: left; justify-content: flex-start; font-weight: 600;
        padding: 0.5rem 0.75rem; font-size: 0.875rem; border-radius: 8px;
        transition: all 0.15s;
    }
    [data-testid="stSidebar"] .stButton > button:hover {
        background: #181c23; color: #e8edf5; border-color: #252d3d;
    }
    [data-testid="stSidebar"] .stButton > button:focus:not(:active) {
        background: rgba(57,229,160,0.1); color: #39e5a0; border-color: rgba(57,229,160,0.25);
        box-shadow: none;
    }

    /* Sidebar labels */
    .sidebar-label {
        font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.12em;
        color: #5a6580; font-weight: 700; padding: 0 0.75rem; margin: 1rem 0 0.25rem;
    }
    .sidebar-logo {
        display: flex; align-items: center; gap: 0.625rem; padding: 0 0.75rem 1rem;
        border-bottom: 1px solid #1e2430; margin-bottom: 0.5rem;
    }
    .sidebar-logo-icon {
        width: 34px; height: 34px; background: linear-gradient(135deg, #39e5a0, #2bb57c);
        border-radius: 9px; display: flex; align-items: center; justify-content: center;
        font-size: 18px;
    }
    .sidebar-logo-text { font-weight: 800; font-size: 1rem; color: #e8edf5; line-height: 1.1; }
    .sidebar-logo-sub { font-size: 0.65rem; color: #5a6580; letter-spacing: 0.08em;
        text-transform: uppercase; font-weight: 500; }

    /* Page header */
    .page-head {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 1.75rem; padding-bottom: 1rem; border-bottom: 1px solid #1e2430;
    }
    .page-title { font-size: 1.625rem; font-weight: 800; color: #e8edf5; letter-spacing: -0.02em; }
    .page-subtitle { font-size: 0.8rem; color: #5a6580; margin-top: 0.25rem; font-weight: 500; }

    /* Badges */
    .badge {
        display: inline-flex; align-items: center; gap: 0.35rem;
        padding: 0.3rem 0.7rem; border-radius: 999px; font-size: 0.7rem;
        font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
    }
    .badge-cult { background: rgba(57,229,160,0.12); color: #39e5a0; border: 1px solid rgba(57,229,160,0.25); }
    .badge-dist { background: rgba(58,143,255,0.12); color: #3a8fff; border: 1px solid rgba(58,143,255,0.25); }
    .badge-live { background: rgba(57,229,160,0.12); color: #39e5a0; }
    .badge-live::before { content: "●"; color: #39e5a0; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* KPI cards */
    .kpi-card {
        background: #111318; border: 1px solid #1e2430; border-radius: 12px;
        padding: 1.1rem 1.25rem; transition: all 0.2s;
    }
    .kpi-card:hover { border-color: #2a3547; transform: translateY(-1px); }
    .kpi-label {
        font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
        color: #8a96b0; font-weight: 600; margin-bottom: 0.5rem;
    }
    .kpi-value {
        font-family: 'JetBrains Mono', monospace; font-size: 1.75rem; font-weight: 700;
        color: #e8edf5; line-height: 1.1; letter-spacing: -0.02em;
    }
    .kpi-delta {
        font-size: 0.7rem; font-weight: 600; margin-top: 0.4rem;
        font-family: 'JetBrains Mono', monospace;
    }
    .kpi-delta.up { color: #39e5a0; }
    .kpi-delta.down { color: #e85959; }
    .kpi-delta.neutral { color: #8a96b0; }
    .kpi-accent-green .kpi-value { color: #39e5a0; }
    .kpi-accent-blue .kpi-value { color: #3a8fff; }
    .kpi-accent-amber .kpi-value { color: #f5a623; }
    .kpi-accent-red .kpi-value { color: #e85959; }
    .kpi-accent-purple .kpi-value { color: #c084fc; }

    /* Section titles */
    .section-title {
        font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em;
        color: #8a96b0; font-weight: 700; margin: 1.5rem 0 0.75rem;
    }

    /* Data editor polish */
    [data-testid="stDataFrame"], [data-testid="stDataEditor"] {
        border-radius: 10px; overflow: hidden; border: 1px solid #1e2430;
    }

    /* Dividers */
    hr { border-color: #1e2430 !important; margin: 1.5rem 0 !important; }

    /* Buttons */
    .stButton > button {
        border-radius: 8px; font-weight: 600; transition: all 0.15s;
    }

    /* Info boxes */
    [data-testid="stAlert"] {
        border-radius: 10px; border: 1px solid rgba(58,143,255,0.25);
        background: rgba(58,143,255,0.06);
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #252d3d; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #2a3547; }

    /* Dataframe cell font */
    [data-testid="stDataFrame"] td, [data-testid="stDataEditor"] td {
        font-family: 'JetBrains Mono', monospace; font-size: 0.8rem;
    }
</style>
""", unsafe_allow_html=True)

# ─── EMPTY SCHEMAS ───────────────────────────────────────────────────────────
SCHEMAS = {
    "strains": pd.DataFrame(columns=["name", "rootDays", "vegDays", "flowerDays", "color"]),
    "harvests": pd.DataFrame(columns=["id", "strain", "date", "wetWeight", "buckedWeight", "trimWeight", "flowerWeight", "costPerGram", "revenuePerGram"]),
    "veg_plants": pd.DataFrame(columns=["strain", "count", "tableId", "dayInVeg", "health"]),
    "flower_tables": pd.DataFrame(columns=["id", "strain", "count", "dayOfFlower", "sqFt", "health"]),
    "inventory": pd.DataFrame(columns=["strain", "type", "batch", "weight", "available", "onConsignment", "unit", "costPerG"]),
    "sales": pd.DataFrame(columns=["id", "date", "client", "strain", "weight", "pricePerG", "total", "status"]),
    "consignments": pd.DataFrame(columns=["id", "client", "strain", "weightOut", "weightSold", "weightReturned", "pricePerG", "dateOut", "due", "status"]),
    "clients": pd.DataFrame(columns=["name", "contact", "email", "phone", "ytdPurchases", "balance", "tier"]),
    "vendors": pd.DataFrame(columns=["name", "category", "ytdSpend", "lastOrder", "terms"]),
    "planting_schedule": pd.DataFrame(columns=["strain", "cloneDate", "transplantDate", "vegStartDate", "flowerStartDate", "harvestEstDate", "cloneCount", "status"]),
    "shipments": pd.DataFrame(columns=["id", "client", "weight", "carrier", "tracking", "dispatch", "est", "status"]),
    "devices": pd.DataFrame(columns=["name", "type", "status", "last", "fw"]),
    "arroyo_veg": pd.DataFrame([{"temp": 0.0, "humidity": 0.0, "co2": 0, "vpd": 0.0, "lightHrs": 18}]),
    "arroyo_flower": pd.DataFrame([{"temp": 0.0, "humidity": 0.0, "co2": 0, "vpd": 0.0, "lightHrs": 12}]),
    "aroya_readings": pd.DataFrame(columns=["timestamp", "facility", "room", "sensor_id", "sensor_name", "metric", "value", "unit"]),
}

# ─── SESSION STATE INIT ──────────────────────────────────────────────────────
for key, df in SCHEMAS.items():
    if key not in st.session_state:
        st.session_state[key] = df.copy()

# ─── AROYA CLIENT ────────────────────────────────────────────────────────────
AROYA_DEFAULTS = {
    "base_url": "https://app.aroya.io/api/v1",
    "token": "",
    "path_facilities": "/facilities",
    "path_rooms": "/facilities/{facility_id}/rooms",
    "path_sensors": "/rooms/{room_id}/sensors",
    "path_readings": "/sensors/{sensor_id}/readings",
}
for k, v in AROYA_DEFAULTS.items():
    st.session_state.setdefault(f"aroya_{k}", st.secrets.get(f"aroya_{k}", v) if hasattr(st, "secrets") else v)

def aroya_headers():
    tok = st.session_state.get("aroya_token", "")
    return {"Authorization": f"Bearer {tok}", "Accept": "application/json"}

def aroya_request(path, params=None, method="GET"):
    base = st.session_state.get("aroya_base_url", "").rstrip("/")
    url = base + path if path.startswith("/") else f"{base}/{path}"
    try:
        r = requests.request(method, url, headers=aroya_headers(), params=params, timeout=20)
        return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text)
    except requests.RequestException as e:
        return None, {"error": str(e)}

def aroya_validate():
    return aroya_request("/validate/")

def _extract_list(payload):
    """AROYA responses may be a list or wrapped in {'data': [...]} or {'results': [...]}."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "results", "items", "facilities", "rooms", "sensors", "readings"):
            if key in payload and isinstance(payload[key], list):
                return payload[key]
    return []

# ─── OPTIONS ─────────────────────────────────────────────────────────────────
HEALTH_OPTS = ["excellent", "good", "fair", "poor"]
SALE_STATUS = ["paid", "pending", "overdue"]
CONSIGN_STATUS = ["active", "settled", "overdue"]
PLANTING_STATUS = ["planned", "rooting", "vegging", "flowering", "harvested"]
SHIP_STATUS = ["pending", "in transit", "delivered", "returned"]
TIER_OPTS = ["standard", "premium"]
INV_TYPES = ["Flower", "Trim", "Pre-roll", "Concentrate", "Other"]

# ─── SIDEBAR NAVIGATION ──────────────────────────────────────────────────────
overview_pages = ["📊 Dashboard"]
cult_pages = ["🌱 Planting Schedule", "🪴 Veg Room", "🌸 Flowering Room", "⚖️ Processing", "🌡️ AROYA Sensors", "🥽 AR / VR Integration"]
dist_pages = ["📦 Inventory", "💰 Sales", "🔄 Consignment", "🤝 Clients", "🏭 Vendors", "🚚 Shipping"]

if "page" not in st.session_state:
    st.session_state.page = "📊 Dashboard"

with st.sidebar:
    st.markdown(
        '<div class="sidebar-logo">'
        '<div class="sidebar-logo-icon">🌿</div>'
        '<div><div class="sidebar-logo-text">CannaOps</div>'
        '<div class="sidebar-logo-sub">Management Suite</div></div>'
        '</div>',
        unsafe_allow_html=True,
    )

    st.markdown('<div class="sidebar-label">Overview</div>', unsafe_allow_html=True)
    for p in overview_pages:
        if st.button(p, key=f"nav_{p}", use_container_width=True):
            st.session_state.page = p

    st.markdown('<div class="sidebar-label">Cultivation</div>', unsafe_allow_html=True)
    for p in cult_pages:
        if st.button(p, key=f"nav_{p}", use_container_width=True):
            st.session_state.page = p

    st.markdown('<div class="sidebar-label">Distribution</div>', unsafe_allow_html=True)
    for p in dist_pages:
        if st.button(p, key=f"nav_{p}", use_container_width=True):
            st.session_state.page = p

    st.markdown("<br>", unsafe_allow_html=True)
    st.divider()
    if st.button("🗑️  Reset All Data", use_container_width=True):
        for key, df in SCHEMAS.items():
            st.session_state[key] = df.copy()
        st.rerun()

page = st.session_state.page

# ─── HELPERS ─────────────────────────────────────────────────────────────────
PAGE_SUBTITLES = {
    "📊 Dashboard": "Real-time operations overview",
    "🌱 Planting Schedule": "Strain library & batch planning",
    "🪴 Veg Room": "Vegetative stage tracking",
    "🌸 Flowering Room": "Flowering stage tracking",
    "⚖️ Processing": "Post-harvest weight logs",
    "🌡️ AROYA Sensors": "Live environmental data from AROYA",
    "🥽 AR / VR Integration": "Immersive facility monitoring",
    "📦 Inventory": "Stock on hand & valuation",
    "💰 Sales": "Orders & revenue",
    "🔄 Consignment": "Outstanding consignment inventory",
    "🤝 Clients": "Dispensary & wholesale accounts",
    "🏭 Vendors": "Supplier spend & terms",
    "🚚 Shipping": "Outbound logistics",
}

def page_header(title, badge=None):
    subtitle = PAGE_SUBTITLES.get(title, "")
    badge_html = ""
    if badge == "cult":
        badge_html = '<span class="badge badge-cult">🌿 Cultivation</span>'
    elif badge == "dist":
        badge_html = '<span class="badge badge-dist">📦 Distribution</span>'
    elif badge == "overview":
        badge_html = '<span class="badge badge-live">Live</span>'
    st.markdown(
        f'<div class="page-head">'
        f'<div><div class="page-title">{title}</div>'
        f'<div class="page-subtitle">{subtitle}</div></div>'
        f'<div>{badge_html}</div>'
        f'</div>',
        unsafe_allow_html=True,
    )

def kpi(label, value, delta=None, accent="green", delta_dir="up"):
    delta_html = ""
    if delta:
        arrow = "↑" if delta_dir == "up" else ("↓" if delta_dir == "down" else "→")
        delta_html = f'<div class="kpi-delta {delta_dir}">{arrow} {delta}</div>'
    return (
        f'<div class="kpi-card kpi-accent-{accent}">'
        f'<div class="kpi-label">{label}</div>'
        f'<div class="kpi-value">{value}</div>'
        f'{delta_html}'
        f'</div>'
    )

def kpi_row(items):
    """items: list of dicts with label/value/delta/accent/delta_dir."""
    cols = st.columns(len(items))
    for col, item in zip(cols, items):
        with col:
            st.markdown(kpi(**item), unsafe_allow_html=True)

def section(title):
    st.markdown(f'<div class="section-title">{title}</div>', unsafe_allow_html=True)

def editable(key, column_config=None, num_rows="dynamic"):
    edited = st.data_editor(
        st.session_state[key],
        num_rows=num_rows,
        use_container_width=True,
        column_config=column_config or {},
        key=f"editor_{key}",
        hide_index=True,
    )
    st.session_state[key] = edited
    return edited

# ─── PAGES ───────────────────────────────────────────────────────────────────
if page == "📊 Dashboard":
    page_header("📊 Dashboard", "overview")

    harvests = st.session_state.harvests
    sales = st.session_state.sales

    total_rev = (harvests["revenuePerGram"].fillna(0) * harvests["flowerWeight"].fillna(0)).sum() if len(harvests) else 0
    total_cost = (harvests["costPerGram"].fillna(0) * harvests["flowerWeight"].fillna(0)).sum() if len(harvests) else 0
    pnl = total_rev - total_cost
    dist_rev = sales["total"].fillna(0).sum() if len(sales) else 0
    avg_cpg = harvests["costPerGram"].fillna(0).mean() if len(harvests) else 0
    avg_rpg = harvests["revenuePerGram"].fillna(0).mean() if len(harvests) else 0

    kpi_row([
        {"label": "Avg Cost / Gram",     "value": f"${avg_cpg:.2f}",  "accent": "amber"},
        {"label": "Avg Revenue / Gram",  "value": f"${avg_rpg:.2f}",  "accent": "green"},
        {"label": "Cultivation P&L",     "value": f"${pnl:,.0f}",     "accent": "green" if pnl >= 0 else "red"},
        {"label": "Distribution Revenue","value": f"${dist_rev:,.0f}","accent": "blue"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)

    left, right = st.columns(2)
    with left:
        section("Cost per Gram by Harvest")
        if len(harvests) and harvests["costPerGram"].notna().any():
            st.bar_chart(harvests.set_index("id")[["costPerGram"]].dropna(), color="#f5a623")
        else:
            st.info("No harvest data yet. Add harvests in the Processing page.")

    with right:
        section("Revenue per Gram by Harvest")
        if len(harvests) and harvests["revenuePerGram"].notna().any():
            st.bar_chart(harvests.set_index("id")[["revenuePerGram"]].dropna(), color="#39e5a0")
        else:
            st.info("No harvest data yet.")

    st.markdown("<br>", unsafe_allow_html=True)
    section("P&L Summary")
    pnl_rows = [
        ("Cultivation Revenue", total_rev),
        ("Cultivation COGS", -total_cost),
        ("Cultivation Net", total_rev - total_cost),
        ("Distribution Revenue", dist_rev),
        ("Distribution COGS (est. 38%)", -dist_rev * 0.38),
        ("Distribution Net", dist_rev * 0.62),
        ("Combined Net P&L", pnl + dist_rev * 0.62),
    ]
    st.dataframe(pd.DataFrame(pnl_rows, columns=["Line Item", "Amount ($)"]), use_container_width=True, hide_index=True)

elif page == "🌱 Planting Schedule":
    page_header("🌱 Planting Schedule", "cult")

    section("Strain Library")
    editable("strains", {
        "name": st.column_config.TextColumn("Strain Name", required=True),
        "rootDays": st.column_config.NumberColumn("Rooting Days", min_value=0),
        "vegDays": st.column_config.NumberColumn("Veg Days", min_value=0),
        "flowerDays": st.column_config.NumberColumn("Flower Days", min_value=0),
        "color": st.column_config.TextColumn("Color (hex)", help="e.g. #4a90d9"),
    })

    section("Active & Planned Batches")
    editable("planting_schedule", {
        "strain": st.column_config.TextColumn("Strain", required=True),
        "cloneDate": st.column_config.DateColumn("Clone Date"),
        "transplantDate": st.column_config.DateColumn("Transplant"),
        "vegStartDate": st.column_config.DateColumn("Veg Start"),
        "flowerStartDate": st.column_config.DateColumn("Flower Start"),
        "harvestEstDate": st.column_config.DateColumn("Est. Harvest"),
        "cloneCount": st.column_config.NumberColumn("Clones", min_value=0),
        "status": st.column_config.SelectboxColumn("Status", options=PLANTING_STATUS),
    })

elif page == "🪴 Veg Room":
    page_header("🪴 Veg Room", "cult")

    vp = st.session_state.veg_plants
    total_plants = vp["count"].fillna(0).sum() if len(vp) else 0
    avg_veg = vp["dayInVeg"].fillna(0).mean() if len(vp) else 0
    n_strains = vp["strain"].nunique() if len(vp) else 0

    kpi_row([
        {"label": "Total Plants",   "value": f"{int(total_plants)}", "accent": "green"},
        {"label": "Active Tables",  "value": f"{len(vp)}",           "accent": "blue"},
        {"label": "Strains",        "value": f"{int(n_strains)}",    "accent": "amber"},
        {"label": "Avg Day in Veg", "value": f"{avg_veg:.0f}d",      "accent": "purple"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)
    section("Veg Tables")
    editable("veg_plants", {
        "strain": st.column_config.TextColumn("Strain", required=True),
        "count": st.column_config.NumberColumn("Plants", min_value=0),
        "tableId": st.column_config.TextColumn("Table ID"),
        "dayInVeg": st.column_config.NumberColumn("Day in Veg", min_value=0),
        "health": st.column_config.SelectboxColumn("Health", options=HEALTH_OPTS),
    })

    section("🌡️ Arroyo — Veg Environment")
    editable("arroyo_veg", {
        "temp": st.column_config.NumberColumn("Temp (°F)"),
        "humidity": st.column_config.NumberColumn("RH (%)"),
        "co2": st.column_config.NumberColumn("CO₂ (ppm)"),
        "vpd": st.column_config.NumberColumn("VPD (kPa)"),
        "lightHrs": st.column_config.NumberColumn("Photoperiod (hrs)"),
    }, num_rows="fixed")

elif page == "🌸 Flowering Room":
    page_header("🌸 Flowering Room", "cult")

    ft = st.session_state.flower_tables
    total_plants = ft["count"].fillna(0).sum() if len(ft) else 0
    total_sqft = ft["sqFt"].fillna(0).sum() if len(ft) else 0
    n_strains = ft["strain"].nunique() if len(ft) else 0

    kpi_row([
        {"label": "Total Plants",      "value": f"{int(total_plants)}",  "accent": "green"},
        {"label": "Total Tables",      "value": f"{len(ft)}",            "accent": "blue"},
        {"label": "Canopy Sq Ft",      "value": f"{int(total_sqft)} ft²","accent": "amber"},
        {"label": "Strains Flowering", "value": f"{int(n_strains)}",     "accent": "purple"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)
    section("Flowering Tables")
    editable("flower_tables", {
        "id": st.column_config.TextColumn("Table ID"),
        "strain": st.column_config.TextColumn("Strain", required=True),
        "count": st.column_config.NumberColumn("Plants", min_value=0),
        "dayOfFlower": st.column_config.NumberColumn("Day of Flower", min_value=0),
        "sqFt": st.column_config.NumberColumn("Sq Ft", min_value=0),
        "health": st.column_config.SelectboxColumn("Health", options=HEALTH_OPTS),
    })

    section("🌡️ Arroyo — Flower Environment")
    editable("arroyo_flower", {
        "temp": st.column_config.NumberColumn("Temp (°F)"),
        "humidity": st.column_config.NumberColumn("RH (%)"),
        "co2": st.column_config.NumberColumn("CO₂ (ppm)"),
        "vpd": st.column_config.NumberColumn("VPD (kPa)"),
        "lightHrs": st.column_config.NumberColumn("Photoperiod (hrs)"),
    }, num_rows="fixed")

elif page == "⚖️ Processing":
    page_header("⚖️ Processing", "cult")

    h = st.session_state.harvests
    total_flower = h["flowerWeight"].fillna(0).sum() if len(h) else 0
    total_trim = h["trimWeight"].fillna(0).sum() if len(h) else 0
    avg_yield = 0
    if len(h):
        ratios = h["flowerWeight"].fillna(0) / h["wetWeight"].replace(0, pd.NA)
        avg_yield = ratios.dropna().mean() * 100 if ratios.notna().any() else 0

    kpi_row([
        {"label": "Total Harvests",       "value": f"{len(h)}",             "accent": "blue"},
        {"label": "Total Flower Weight",  "value": f"{total_flower:,.0f}g", "accent": "green"},
        {"label": "Avg Flower % of Wet",  "value": f"{avg_yield:.1f}%",     "accent": "amber"},
        {"label": "Total Trim Weight",    "value": f"{total_trim:,.0f}g",   "accent": "purple"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)
    section("Harvest Weight Log")
    editable("harvests", {
        "id": st.column_config.TextColumn("Harvest ID", required=True),
        "strain": st.column_config.TextColumn("Strain", required=True),
        "date": st.column_config.DateColumn("Date"),
        "wetWeight": st.column_config.NumberColumn("Wet (g)", min_value=0),
        "buckedWeight": st.column_config.NumberColumn("Bucked (g)", min_value=0),
        "trimWeight": st.column_config.NumberColumn("Trim (g)", min_value=0),
        "flowerWeight": st.column_config.NumberColumn("Flower (g)", min_value=0),
        "costPerGram": st.column_config.NumberColumn("Cost/g ($)", min_value=0, format="$%.2f"),
        "revenuePerGram": st.column_config.NumberColumn("Revenue/g ($)", min_value=0, format="$%.2f"),
    })

elif page == "🌡️ AROYA Sensors":
    page_header("🌡️ AROYA Sensors", "cult")

    with st.expander("🔧 Connection Settings", expanded=not st.session_state.get("aroya_token")):
        c1, c2 = st.columns([2, 1])
        with c1:
            st.session_state.aroya_base_url = st.text_input(
                "Base URL", value=st.session_state.aroya_base_url,
                help="AROYA API base URL (confirm with AROYA support)")
            st.session_state.aroya_token = st.text_input(
                "API Token", value=st.session_state.aroya_token, type="password",
                help="Request from AROYA customer support. Tokens mirror user permissions.")
        with c2:
            st.markdown("**Endpoint Paths** (adjust if needed)")
            st.session_state.aroya_path_facilities = st.text_input("Facilities", value=st.session_state.aroya_path_facilities)
            st.session_state.aroya_path_rooms = st.text_input("Rooms", value=st.session_state.aroya_path_rooms)
            st.session_state.aroya_path_sensors = st.text_input("Sensors", value=st.session_state.aroya_path_sensors)
            st.session_state.aroya_path_readings = st.text_input("Readings", value=st.session_state.aroya_path_readings)

        bcol1, bcol2, _ = st.columns([1, 1, 3])
        if bcol1.button("🔌 Test Connection", type="primary"):
            if not st.session_state.aroya_token:
                st.error("Enter an API token first.")
            else:
                code, payload = aroya_validate()
                if code == 200:
                    st.success(f"✓ Connected — {payload if isinstance(payload, (str, dict)) else 'OK'}")
                elif code is None:
                    st.error(f"Network error: {payload.get('error')}")
                else:
                    st.error(f"HTTP {code}: {payload}")

    with st.expander("🔐 Scraper Login (temporary — until API token arrives)", expanded=False):
        st.caption("Runs a headless Chrome browser on the server, logs into AROYA, and captures sensor data. "
                   "Store credentials in Streamlit **Secrets** (Settings → Secrets) as `aroya_user` and `aroya_pass`.")
        default_user = ""
        default_pass = ""
        try:
            default_user = st.secrets.get("aroya_user", "")
            default_pass = st.secrets.get("aroya_pass", "")
        except Exception:
            pass

        sc1, sc2 = st.columns(2)
        scrape_user = sc1.text_input("AROYA Email", value=default_user, key="scrape_user")
        scrape_pass = sc2.text_input("AROYA Password", value=default_pass, type="password", key="scrape_pass")

        sc3, sc4 = st.columns(2)
        scrape_login = sc3.text_input("Login URL", value="https://app.aroya.io/login", key="scrape_login")
        scrape_targets = sc4.text_input("Target URLs (comma-separated)", value="https://app.aroya.io/", key="scrape_targets")
        sc5, sc6 = st.columns(2)
        scrape_wait = sc5.slider("Min wait seconds (auto-continues once network idle)", 10, 120, 45)
        login_timeout = sc6.slider("Login timeout (seconds)", 30, 300, 120)
        st.caption("💡 Tip: paste multiple URLs to hit specific room pages — e.g. "
                   "`https://app.aroya.io/f/3766/rooms/11955, https://app.aroya.io/f/3766/rooms/16069` "
                   "to capture per-room sensor history.")

        if st.button("🤖 Run Scraper Now", type="primary"):
            if not scrape_user or not scrape_pass:
                st.error("Enter AROYA credentials.")
            else:
                with st.spinner(f"Launching Chrome, logging in, capturing XHRs... (up to {login_timeout + scrape_wait + 30}s)"):
                    try:
                        from aroya_scraper import scrape_aroya
                        result = scrape_aroya(
                            scrape_user, scrape_pass,
                            login_url=scrape_login,
                            target_urls=[u.strip() for u in scrape_targets.split(",") if u.strip()],
                            headless=True,
                            wait_secs=scrape_wait,
                            login_timeout=login_timeout,
                        )
                        st.session_state["_aroya_last_result"] = result

                        if result.get("error"):
                            st.error(f"Scraper failed: {result['error']}")
                        elif result["rows"]:
                            new_df = pd.DataFrame(result["rows"])
                            cols = ["timestamp", "facility", "room", "sensor_id", "sensor_name", "metric", "value", "unit"]
                            for c in cols:
                                if c not in new_df.columns:
                                    new_df[c] = ""
                            existing = st.session_state.aroya_readings
                            combined = pd.concat([existing, new_df[cols]], ignore_index=True).drop_duplicates(
                                subset=["timestamp", "sensor_id", "metric"], keep="last")
                            st.session_state.aroya_readings = combined
                            st.success(f"✓ Landed at {result['landing_url']}. Captured {len(new_df)} readings "
                                       f"from {len(result['endpoints'])} endpoints. Total stored: {len(combined)}")
                        else:
                            st.warning(f"Logged in (landed at {result['landing_url']}) but no readings flattened. "
                                       f"Hit {len(result['endpoints'])} endpoints — see below to inspect raw payloads.")
                    except Exception as e:
                        st.error(f"Scraper failed: {type(e).__name__}: {e}")

        # Debug surface for last run
        last = st.session_state.get("_aroya_last_result")
        if last:
            snap = last.get("snapshot") or {}
            if snap.get("png_b64"):
                with st.expander("🖼️ Browser screenshot (what Chrome saw)", expanded=bool(last.get("error"))):
                    st.caption(f"URL: `{snap.get('url', '?')}` · Title: `{snap.get('title', '?')}`")
                    import base64 as _b64
                    st.image(_b64.b64decode(snap["png_b64"]))
            if snap.get("html_preview"):
                with st.expander("📄 Page HTML preview (first 3000 chars)"):
                    st.code(snap["html_preview"], language="html")
            if last.get("endpoints"):
                with st.expander(f"🔍 Endpoints hit ({len(last['endpoints'])})"):
                    st.code("\n".join(last["endpoints"]))
            if last.get("captures"):
                with st.expander(f"📊 Capture stats by endpoint"):
                    stats = {}
                    for c in last["captures"]:
                        u = c["url"].split("?")[0]
                        s = stats.setdefault(u, {"count": 0, "bytes": 0})
                        s["count"] += 1
                        try:
                            import json as _json
                            s["bytes"] += len(_json.dumps(c["payload"]))
                        except Exception:
                            pass
                    stats_df = pd.DataFrame([
                        {"endpoint": k, "responses": v["count"], "bytes": v["bytes"]}
                        for k, v in sorted(stats.items(), key=lambda x: -x[1]["bytes"])
                    ])
                    st.dataframe(stats_df, use_container_width=True, hide_index=True)
                with st.expander(f"🔍 Raw captured JSON ({len(last['captures'])} responses, showing first 3)"):
                    st.json(last["captures"][:3])
                # raw download
                import json as _json
                raw_blob = _json.dumps(last["captures"], indent=2, default=str).encode("utf-8")
                st.download_button("⬇️ Download Raw JSON", data=raw_blob,
                                   file_name=f"aroya_raw_{datetime.now():%Y%m%d_%H%M}.json",
                                   mime="application/json")

        if "_aroya_last_endpoints" in st.session_state:
            with st.expander(f"🔍 Endpoints hit ({len(st.session_state['_aroya_last_endpoints'])})"):
                st.code("\n".join(st.session_state["_aroya_last_endpoints"]))
        if "_aroya_last_captures" in st.session_state:
            with st.expander(f"🔍 Raw captured JSON ({len(st.session_state['_aroya_last_captures'])} responses)"):
                st.json(st.session_state["_aroya_last_captures"][:5])

    with st.expander("📁 Or upload CSV from local scraper run", expanded=False):
        uploaded = st.file_uploader("Upload scraper CSV", type=["csv"], key="aroya_csv_upload")
        if uploaded is not None:
            try:
                new_df = pd.read_csv(uploaded)
                cols = ["timestamp", "facility", "room", "sensor_id", "sensor_name", "metric", "value", "unit"]
                for c in cols:
                    if c not in new_df.columns:
                        new_df[c] = ""
                existing = st.session_state.aroya_readings
                combined = pd.concat([existing, new_df[cols]], ignore_index=True).drop_duplicates(
                    subset=["timestamp", "sensor_id", "metric"], keep="last")
                st.session_state.aroya_readings = combined
                st.success(f"✓ Imported {len(new_df)} rows. Total stored: {len(combined)}")
            except Exception as e:
                st.error(f"Failed to parse CSV: {e}")

    if not st.session_state.aroya_token:
        st.info("👆 Enter your AROYA API token above, **or** use the Selenium scraper importer to begin capturing sensor data.")
        # don't stop — allow viewing previously captured readings below

    # ── Facility / Room Picker (API mode) ──
    section("Facilities & Rooms (API)")
    if not st.session_state.aroya_token:
        st.caption("⚠ No API token set — skip this section and use the scraper importer above, or paste a token to enable.")

    if st.button("🔄 Refresh Facilities", disabled=not st.session_state.aroya_token):
        code, payload = aroya_request(st.session_state.aroya_path_facilities)
        if code == 200:
            st.session_state["_aroya_facilities"] = _extract_list(payload)
            st.success(f"Loaded {len(st.session_state['_aroya_facilities'])} facility(ies).")
        else:
            st.error(f"Failed ({code}): {payload}")

    facilities = st.session_state.get("_aroya_facilities", [])
    if facilities:
        fac_opts = {str(f.get("name", f.get("id", "?"))): f for f in facilities}
        fac_name = st.selectbox("Facility", list(fac_opts.keys()))
        facility = fac_opts[fac_name]
        fac_id = facility.get("id") or facility.get("facility_id")

        room_path = st.session_state.aroya_path_rooms.format(facility_id=fac_id)
        if st.button("🔄 Load Rooms"):
            code, payload = aroya_request(room_path)
            if code == 200:
                st.session_state["_aroya_rooms"] = _extract_list(payload)
                st.success(f"Loaded {len(st.session_state['_aroya_rooms'])} room(s).")
            else:
                st.error(f"Failed ({code}): {payload}")

        rooms = st.session_state.get("_aroya_rooms", [])
        if rooms:
            room_opts = {str(r.get("name", r.get("id", "?"))): r for r in rooms}
            selected_rooms = st.multiselect("Rooms to capture", list(room_opts.keys()), default=list(room_opts.keys()))

            # ── Reading Capture ──
            section("Capture Sensor Readings")
            tcol1, tcol2, tcol3 = st.columns(3)
            with tcol1:
                hours_back = st.number_input("Hours of history", min_value=1, max_value=720, value=24)
            with tcol2:
                start_iso = (datetime.now(timezone.utc) - timedelta(hours=hours_back)).isoformat()
                st.text_input("Start (UTC)", value=start_iso, disabled=True)
            with tcol3:
                end_iso = datetime.now(timezone.utc).isoformat()
                st.text_input("End (UTC)", value=end_iso, disabled=True)

            if st.button("⬇️ Pull All Sensor Data", type="primary"):
                all_rows = []
                progress = st.progress(0.0, text="Fetching sensors...")
                total = max(len(selected_rooms), 1)
                for i, rn in enumerate(selected_rooms):
                    room = room_opts[rn]
                    room_id = room.get("id") or room.get("room_id")
                    # list sensors in room
                    sensors_path = st.session_state.aroya_path_sensors.format(room_id=room_id)
                    code, payload = aroya_request(sensors_path)
                    if code != 200:
                        st.warning(f"Room '{rn}': sensor list failed ({code})")
                        progress.progress((i + 1) / total)
                        continue
                    sensors = _extract_list(payload)
                    for sensor in sensors:
                        sid = sensor.get("id") or sensor.get("sensor_id")
                        sname = sensor.get("name") or sensor.get("type") or str(sid)
                        readings_path = st.session_state.aroya_path_readings.format(sensor_id=sid)
                        code2, payload2 = aroya_request(readings_path, params={"start": start_iso, "end": end_iso})
                        if code2 != 200:
                            continue
                        for reading in _extract_list(payload2):
                            # best-effort parse — AROYA may use various field names
                            ts = reading.get("timestamp") or reading.get("time") or reading.get("recorded_at")
                            metrics = {}
                            for key in ("temperature", "temp_c", "temp_f", "humidity", "rh",
                                        "co2", "co2_ppm", "vpd", "vpd_kpa", "value", "moisture", "ec", "ph",
                                        "par", "ppfd", "temp", "soil_temp", "soil_moisture", "ec_porewater"):
                                if key in reading and reading[key] is not None:
                                    metrics[key] = reading[key]
                            if not metrics and "metric" in reading and "value" in reading:
                                metrics[reading["metric"]] = reading["value"]
                            for metric, value in metrics.items():
                                all_rows.append({
                                    "timestamp": ts,
                                    "facility": fac_name,
                                    "room": rn,
                                    "sensor_id": str(sid),
                                    "sensor_name": sname,
                                    "metric": metric,
                                    "value": value,
                                    "unit": reading.get("unit", ""),
                                })
                    progress.progress((i + 1) / total)
                progress.empty()

                if all_rows:
                    new_df = pd.DataFrame(all_rows)
                    existing = st.session_state.aroya_readings
                    combined = pd.concat([existing, new_df], ignore_index=True).drop_duplicates(
                        subset=["timestamp", "sensor_id", "metric"], keep="last")
                    st.session_state.aroya_readings = combined
                    st.success(f"✓ Captured {len(new_df)} new readings. Total stored: {len(combined)}")
                else:
                    st.warning("No readings returned. Check endpoint paths and date range.")

    # ── Captured Data ──
    readings = st.session_state.aroya_readings
    section("Captured Readings")

    if len(readings) == 0:
        st.info("No sensor data captured yet. Configure connection above and pull data.")
    else:
        # summary KPIs
        kpi_row([
            {"label": "Total Readings",  "value": f"{len(readings):,}",              "accent": "green"},
            {"label": "Unique Sensors",  "value": f"{readings['sensor_id'].nunique()}", "accent": "blue"},
            {"label": "Metrics Tracked", "value": f"{readings['metric'].nunique()}",    "accent": "amber"},
            {"label": "Rooms",           "value": f"{readings['room'].nunique()}",      "accent": "purple"},
        ])

        st.markdown("<br>", unsafe_allow_html=True)

        # filters + chart
        fc1, fc2 = st.columns(2)
        metric_sel = fc1.multiselect("Filter: metrics", sorted(readings["metric"].unique()),
                                      default=list(readings["metric"].unique())[:3])
        room_sel = fc2.multiselect("Filter: rooms", sorted(readings["room"].unique()),
                                    default=list(readings["room"].unique()))

        filtered = readings[readings["metric"].isin(metric_sel) & readings["room"].isin(room_sel)].copy()
        if len(filtered):
            filtered["timestamp"] = pd.to_datetime(filtered["timestamp"], errors="coerce", utc=True)
            filtered = filtered.dropna(subset=["timestamp"])
            filtered["value"] = pd.to_numeric(filtered["value"], errors="coerce")
            if len(filtered):
                pivot = filtered.pivot_table(index="timestamp", columns="metric", values="value", aggfunc="mean")
                section("Time Series")
                st.line_chart(pivot)

        section("Raw Readings")
        st.dataframe(readings.sort_values("timestamp", ascending=False), use_container_width=True, hide_index=True, height=400)

        dlcol1, dlcol2 = st.columns([1, 5])
        dlcol1.download_button(
            "⬇️ Export CSV",
            data=readings.to_csv(index=False).encode("utf-8"),
            file_name=f"aroya_readings_{datetime.now():%Y%m%d_%H%M}.csv",
            mime="text/csv",
            use_container_width=True,
        )
        if dlcol2.button("🗑️ Clear Readings", use_container_width=False):
            st.session_state.aroya_readings = SCHEMAS["aroya_readings"].copy()
            st.rerun()

elif page == "🥽 AR / VR Integration":
    page_header("🥽 AR / VR Integration", "cult")

    st.info("🥽 **Meta Quest & AR Glasses Integration** — Live facility monitoring through Meta Quest Pro, Quest 3, or Ray-Ban Meta Smart Glasses. Walk your rooms with real-time plant data overlays.")

    c1, c2, c3 = st.columns(3)
    c1.button("● Start Live Session", use_container_width=True, type="primary")
    c2.button("⏺ Start Recording", use_container_width=True)
    c3.button("📁 View Recordings", use_container_width=True)

    section("Live Feed Features")
    for f in [
        "Real-time plant count overlay per table",
        "Arroyo sensor data (temp, RH, CO₂, VPD) in AR",
        "Harvest stage progress bars per strain",
        "Alert indicators for environmental deviation",
        "Plant health flagging via color-coded heatmap",
    ]:
        st.markdown(f"<span style='color:#39e5a0'>✓</span> <span style='color:#e8edf5'>{f}</span>", unsafe_allow_html=True)

    section("Connected Devices")
    editable("devices", {
        "name": st.column_config.TextColumn("Device"),
        "type": st.column_config.TextColumn("Type"),
        "status": st.column_config.SelectboxColumn("Status", options=["online", "offline"]),
        "last": st.column_config.TextColumn("Last Connected"),
        "fw": st.column_config.TextColumn("Firmware"),
    })

elif page == "📦 Inventory":
    page_header("📦 Inventory", "dist")

    inv = st.session_state.inventory
    total_avail = inv["available"].fillna(0).sum() if len(inv) else 0
    total_consign = inv["onConsignment"].fillna(0).sum() if len(inv) else 0
    est_value = (inv["available"].fillna(0) * inv["costPerG"].fillna(0)).sum() if len(inv) else 0

    kpi_row([
        {"label": "Total SKUs",          "value": f"{len(inv)}",              "accent": "blue"},
        {"label": "Available (g)",       "value": f"{int(total_avail):,}",    "accent": "green"},
        {"label": "On Consignment (g)",  "value": f"{int(total_consign):,}",  "accent": "amber"},
        {"label": "Est. Inventory Value","value": f"${est_value:,.0f}",       "accent": "purple"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)
    editable("inventory", {
        "strain": st.column_config.TextColumn("Strain", required=True),
        "type": st.column_config.SelectboxColumn("Type", options=INV_TYPES),
        "batch": st.column_config.TextColumn("Batch"),
        "weight": st.column_config.NumberColumn("Total (g)", min_value=0),
        "available": st.column_config.NumberColumn("Available (g)", min_value=0),
        "onConsignment": st.column_config.NumberColumn("On Consignment (g)", min_value=0),
        "unit": st.column_config.TextColumn("Unit"),
        "costPerG": st.column_config.NumberColumn("Cost/g ($)", min_value=0, format="$%.2f"),
    })

elif page == "💰 Sales":
    page_header("💰 Sales", "dist")

    s = st.session_state.sales
    total = s["total"].fillna(0).sum() if len(s) else 0
    avg_ticket = total / len(s) if len(s) else 0
    pending = s[s["status"] == "pending"]["total"].fillna(0).sum() if len(s) and "status" in s.columns else 0

    kpi_row([
        {"label": "Total Revenue",    "value": f"${total:,.2f}",     "accent": "green"},
        {"label": "Transactions",     "value": f"{len(s)}",          "accent": "blue"},
        {"label": "Avg Ticket",       "value": f"${avg_ticket:,.2f}","accent": "amber"},
        {"label": "Pending Payments", "value": f"${pending:,.2f}",   "accent": "red"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)
    editable("sales", {
        "id": st.column_config.TextColumn("Order #", required=True),
        "date": st.column_config.DateColumn("Date"),
        "client": st.column_config.TextColumn("Client"),
        "strain": st.column_config.TextColumn("Strain"),
        "weight": st.column_config.NumberColumn("Weight (g)", min_value=0),
        "pricePerG": st.column_config.NumberColumn("Price/g ($)", min_value=0, format="$%.2f"),
        "total": st.column_config.NumberColumn("Total ($)", min_value=0, format="$%.2f"),
        "status": st.column_config.SelectboxColumn("Status", options=SALE_STATUS),
    })

elif page == "🔄 Consignment":
    page_header("🔄 Consignment", "dist")

    c = st.session_state.consignments
    active = c[c["status"] == "active"] if len(c) and "status" in c.columns else pd.DataFrame()
    out_g = c["weightOut"].fillna(0).sum() if len(c) else 0
    sold_g = c["weightSold"].fillna(0).sum() if len(c) else 0
    outstanding = 0
    if len(active):
        outstanding = ((active["weightOut"].fillna(0) - active["weightSold"].fillna(0)) * active["pricePerG"].fillna(0)).sum()

    kpi_row([
        {"label": "Active",             "value": f"{len(active)}",     "accent": "amber"},
        {"label": "Total Out (g)",      "value": f"{int(out_g):,}",    "accent": "green"},
        {"label": "Total Sold (g)",     "value": f"{int(sold_g):,}",   "accent": "blue"},
        {"label": "Outstanding Value",  "value": f"${outstanding:,.2f}","accent": "red"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)
    editable("consignments", {
        "id": st.column_config.TextColumn("ID", required=True),
        "client": st.column_config.TextColumn("Client"),
        "strain": st.column_config.TextColumn("Strain"),
        "weightOut": st.column_config.NumberColumn("Out (g)", min_value=0),
        "weightSold": st.column_config.NumberColumn("Sold (g)", min_value=0),
        "weightReturned": st.column_config.NumberColumn("Returned (g)", min_value=0),
        "pricePerG": st.column_config.NumberColumn("Price/g ($)", min_value=0, format="$%.2f"),
        "dateOut": st.column_config.DateColumn("Date Out"),
        "due": st.column_config.DateColumn("Due"),
        "status": st.column_config.SelectboxColumn("Status", options=CONSIGN_STATUS),
    })

elif page == "🤝 Clients":
    page_header("🤝 Clients", "dist")

    cl = st.session_state.clients
    ytd = cl["ytdPurchases"].fillna(0).sum() if len(cl) else 0
    bal = cl["balance"].fillna(0).sum() if len(cl) else 0
    prem = (cl["tier"] == "premium").sum() if len(cl) and "tier" in cl.columns else 0

    kpi_row([
        {"label": "Total Clients",    "value": f"{len(cl)}",    "accent": "blue"},
        {"label": "YTD Revenue",      "value": f"${ytd:,.0f}",  "accent": "green"},
        {"label": "Open Balances",    "value": f"${bal:,.2f}",  "accent": "red"},
        {"label": "Premium Accounts", "value": f"{int(prem)}",  "accent": "amber"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)
    editable("clients", {
        "name": st.column_config.TextColumn("Client", required=True),
        "contact": st.column_config.TextColumn("Contact"),
        "email": st.column_config.TextColumn("Email"),
        "phone": st.column_config.TextColumn("Phone"),
        "ytdPurchases": st.column_config.NumberColumn("YTD Purchases ($)", min_value=0, format="$%.2f"),
        "balance": st.column_config.NumberColumn("Balance ($)", format="$%.2f"),
        "tier": st.column_config.SelectboxColumn("Tier", options=TIER_OPTS),
    })

elif page == "🏭 Vendors":
    page_header("🏭 Vendors", "dist")

    v = st.session_state.vendors
    total_spend = v["ytdSpend"].fillna(0).sum() if len(v) else 0
    kpi_row([
        {"label": "Total Vendors",  "value": f"{len(v)}",           "accent": "blue"},
        {"label": "YTD Spend",      "value": f"${total_spend:,.0f}","accent": "red"},
        {"label": "Categories",     "value": f"{v['category'].nunique() if len(v) else 0}", "accent": "amber"},
        {"label": "Active Terms",   "value": f"{v['terms'].nunique() if len(v) else 0}",    "accent": "purple"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)
    editable("vendors", {
        "name": st.column_config.TextColumn("Vendor", required=True),
        "category": st.column_config.TextColumn("Category"),
        "ytdSpend": st.column_config.NumberColumn("YTD Spend ($)", min_value=0, format="$%.2f"),
        "lastOrder": st.column_config.DateColumn("Last Order"),
        "terms": st.column_config.TextColumn("Terms"),
    })

elif page == "🚚 Shipping":
    page_header("🚚 Shipping", "dist")

    sh = st.session_state.shipments
    in_transit = (sh["status"] == "in transit").sum() if len(sh) and "status" in sh.columns else 0
    delivered = (sh["status"] == "delivered").sum() if len(sh) and "status" in sh.columns else 0
    pending = (sh["status"] == "pending").sum() if len(sh) and "status" in sh.columns else 0
    kpi_row([
        {"label": "Total Shipments", "value": f"{len(sh)}",    "accent": "blue"},
        {"label": "In Transit",      "value": f"{in_transit}", "accent": "amber"},
        {"label": "Delivered",       "value": f"{delivered}",  "accent": "green"},
        {"label": "Pending",         "value": f"{pending}",    "accent": "purple"},
    ])

    st.markdown("<br>", unsafe_allow_html=True)
    editable("shipments", {
        "id": st.column_config.TextColumn("Shipment #", required=True),
        "client": st.column_config.TextColumn("Client"),
        "weight": st.column_config.TextColumn("Weight"),
        "carrier": st.column_config.TextColumn("Carrier"),
        "tracking": st.column_config.TextColumn("Tracking"),
        "dispatch": st.column_config.DateColumn("Dispatch"),
        "est": st.column_config.DateColumn("Est. Arrival"),
        "status": st.column_config.SelectboxColumn("Status", options=SHIP_STATUS),
    })
