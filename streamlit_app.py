import streamlit as st
import pandas as pd

st.set_page_config(page_title="CannaOps Management Suite", page_icon="🌿", layout="wide")

# ─── CUSTOM STYLING ──────────────────────────────────────────────────────────
st.markdown("""
<style>
    .main > div { padding-top: 1rem; }
    .stMetric { background: #181c23; padding: 12px 16px; border-radius: 10px; border: 1px solid #1e2430; }
    .section-badge-cult { background: rgba(57,229,160,0.15); color: #39e5a0; padding: 4px 10px;
        border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
    .section-badge-dist { background: rgba(58,143,255,0.15); color: #3a8fff; padding: 4px 10px;
        border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
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
}

# ─── SESSION STATE INIT ──────────────────────────────────────────────────────
for key, df in SCHEMAS.items():
    if key not in st.session_state:
        st.session_state[key] = df.copy()

# ─── OPTIONS ─────────────────────────────────────────────────────────────────
HEALTH_OPTS = ["excellent", "good", "fair", "poor"]
SALE_STATUS = ["paid", "pending", "overdue"]
CONSIGN_STATUS = ["active", "settled", "overdue"]
PLANTING_STATUS = ["planned", "rooting", "vegging", "flowering", "harvested"]
SHIP_STATUS = ["pending", "in transit", "delivered", "returned"]
TIER_OPTS = ["standard", "premium"]
INV_TYPES = ["Flower", "Trim", "Pre-roll", "Concentrate", "Other"]

# ─── SIDEBAR NAVIGATION ──────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("### 🌿 **CannaOps**")
    st.caption("Management Suite")
    st.divider()

    overview_pages = ["📊 Dashboard"]
    cult_pages = ["🌱 Planting Schedule", "🪴 Veg Room", "🌸 Flowering Room", "⚖️ Processing", "🥽 AR / VR Integration"]
    dist_pages = ["📦 Inventory", "💰 Sales", "🔄 Consignment", "🤝 Clients", "🏭 Vendors", "🚚 Shipping"]

    if "page" not in st.session_state:
        st.session_state.page = "📊 Dashboard"

    st.markdown("**OVERVIEW**")
    for p in overview_pages:
        if st.button(p, key=f"nav_{p}", use_container_width=True):
            st.session_state.page = p

    st.markdown("**CULTIVATION**")
    for p in cult_pages:
        if st.button(p, key=f"nav_{p}", use_container_width=True):
            st.session_state.page = p

    st.markdown("**DISTRIBUTION**")
    for p in dist_pages:
        if st.button(p, key=f"nav_{p}", use_container_width=True):
            st.session_state.page = p

    st.divider()
    if st.button("🗑️ Reset All Data", use_container_width=True):
        for key, df in SCHEMAS.items():
            st.session_state[key] = df.copy()
        st.rerun()

page = st.session_state.page

# ─── HELPERS ─────────────────────────────────────────────────────────────────
def page_header(title, badge=None):
    cols = st.columns([4, 1])
    with cols[0]:
        st.markdown(f"## {title}")
    with cols[1]:
        if badge == "cult":
            st.markdown('<div style="text-align:right;padding-top:14px"><span class="section-badge-cult">🌿 Cultivation</span></div>', unsafe_allow_html=True)
        elif badge == "dist":
            st.markdown('<div style="text-align:right;padding-top:14px"><span class="section-badge-dist">📦 Distribution</span></div>', unsafe_allow_html=True)

def editable(key, column_config=None, num_rows="dynamic"):
    edited = st.data_editor(
        st.session_state[key],
        num_rows=num_rows,
        use_container_width=True,
        column_config=column_config or {},
        key=f"editor_{key}",
    )
    st.session_state[key] = edited
    return edited

# ─── PAGES ───────────────────────────────────────────────────────────────────
if page == "📊 Dashboard":
    page_header("Executive Dashboard")

    harvests = st.session_state.harvests
    sales = st.session_state.sales

    total_rev = (harvests["revenuePerGram"].fillna(0) * harvests["flowerWeight"].fillna(0)).sum() if len(harvests) else 0
    total_cost = (harvests["costPerGram"].fillna(0) * harvests["flowerWeight"].fillna(0)).sum() if len(harvests) else 0
    pnl = total_rev - total_cost
    dist_rev = sales["total"].fillna(0).sum() if len(sales) else 0
    avg_cpg = harvests["costPerGram"].fillna(0).mean() if len(harvests) else 0
    avg_rpg = harvests["revenuePerGram"].fillna(0).mean() if len(harvests) else 0

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Avg Cost / Gram", f"${avg_cpg:.2f}")
    c2.metric("Avg Revenue / Gram", f"${avg_rpg:.2f}")
    c3.metric("Cultivation P&L", f"${pnl:,.0f}")
    c4.metric("Distribution Revenue", f"${dist_rev:,.2f}")

    st.divider()

    left, right = st.columns(2)
    with left:
        st.markdown("#### Cost per Gram by Harvest")
        if len(harvests) and harvests["costPerGram"].notna().any():
            st.bar_chart(harvests.set_index("id")[["costPerGram"]].dropna())
        else:
            st.info("No harvest data yet. Add harvests in the Processing page.")

    with right:
        st.markdown("#### Revenue per Gram by Harvest")
        if len(harvests) and harvests["revenuePerGram"].notna().any():
            st.bar_chart(harvests.set_index("id")[["revenuePerGram"]].dropna())
        else:
            st.info("No harvest data yet.")

    st.divider()
    st.markdown("#### P&L Summary")
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
    page_header("Planting Schedule", "cult")

    st.markdown("#### Strain Library")
    editable("strains", {
        "name": st.column_config.TextColumn("Strain Name", required=True),
        "rootDays": st.column_config.NumberColumn("Rooting Days", min_value=0),
        "vegDays": st.column_config.NumberColumn("Veg Days", min_value=0),
        "flowerDays": st.column_config.NumberColumn("Flower Days", min_value=0),
        "color": st.column_config.TextColumn("Color (hex)", help="e.g. #4a90d9"),
    })

    st.divider()
    st.markdown("#### Active & Planned Batches")
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
    page_header("Veg Room", "cult")

    vp = st.session_state.veg_plants
    total_plants = vp["count"].fillna(0).sum() if len(vp) else 0
    avg_veg = vp["dayInVeg"].fillna(0).mean() if len(vp) else 0
    n_strains = vp["strain"].nunique() if len(vp) else 0

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total Plants", int(total_plants))
    c2.metric("Active Tables", len(vp))
    c3.metric("Strains", int(n_strains))
    c4.metric("Avg Day in Veg", f"{avg_veg:.0f}d")

    st.divider()
    st.markdown("#### Veg Tables")
    editable("veg_plants", {
        "strain": st.column_config.TextColumn("Strain", required=True),
        "count": st.column_config.NumberColumn("Plants", min_value=0),
        "tableId": st.column_config.TextColumn("Table ID"),
        "dayInVeg": st.column_config.NumberColumn("Day in Veg", min_value=0),
        "health": st.column_config.SelectboxColumn("Health", options=HEALTH_OPTS),
    })

    st.divider()
    st.markdown("#### 🌡️ Arroyo — Veg Environment")
    editable("arroyo_veg", {
        "temp": st.column_config.NumberColumn("Temp (°F)"),
        "humidity": st.column_config.NumberColumn("RH (%)"),
        "co2": st.column_config.NumberColumn("CO₂ (ppm)"),
        "vpd": st.column_config.NumberColumn("VPD (kPa)"),
        "lightHrs": st.column_config.NumberColumn("Photoperiod (hrs)"),
    }, num_rows="fixed")

elif page == "🌸 Flowering Room":
    page_header("Flowering Room", "cult")

    ft = st.session_state.flower_tables
    total_plants = ft["count"].fillna(0).sum() if len(ft) else 0
    total_sqft = ft["sqFt"].fillna(0).sum() if len(ft) else 0
    n_strains = ft["strain"].nunique() if len(ft) else 0

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total Plants", int(total_plants))
    c2.metric("Total Tables", len(ft))
    c3.metric("Canopy Sq Ft", f"{int(total_sqft)} ft²")
    c4.metric("Strains Flowering", int(n_strains))

    st.divider()
    st.markdown("#### Flowering Tables")
    editable("flower_tables", {
        "id": st.column_config.TextColumn("Table ID"),
        "strain": st.column_config.TextColumn("Strain", required=True),
        "count": st.column_config.NumberColumn("Plants", min_value=0),
        "dayOfFlower": st.column_config.NumberColumn("Day of Flower", min_value=0),
        "sqFt": st.column_config.NumberColumn("Sq Ft", min_value=0),
        "health": st.column_config.SelectboxColumn("Health", options=HEALTH_OPTS),
    })

    st.divider()
    st.markdown("#### 🌡️ Arroyo — Flower Environment")
    editable("arroyo_flower", {
        "temp": st.column_config.NumberColumn("Temp (°F)"),
        "humidity": st.column_config.NumberColumn("RH (%)"),
        "co2": st.column_config.NumberColumn("CO₂ (ppm)"),
        "vpd": st.column_config.NumberColumn("VPD (kPa)"),
        "lightHrs": st.column_config.NumberColumn("Photoperiod (hrs)"),
    }, num_rows="fixed")

elif page == "⚖️ Processing":
    page_header("Processing", "cult")

    h = st.session_state.harvests
    total_flower = h["flowerWeight"].fillna(0).sum() if len(h) else 0
    total_trim = h["trimWeight"].fillna(0).sum() if len(h) else 0
    avg_yield = 0
    if len(h):
        ratios = h["flowerWeight"].fillna(0) / h["wetWeight"].replace(0, pd.NA)
        avg_yield = ratios.dropna().mean() * 100 if ratios.notna().any() else 0

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total Harvests", len(h))
    c2.metric("Total Flower Weight", f"{total_flower:,.0f}g")
    c3.metric("Avg Flower % of Wet", f"{avg_yield:.1f}%")
    c4.metric("Total Trim Weight", f"{total_trim:,.0f}g")

    st.divider()
    st.markdown("#### Harvest Weight Log")
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

elif page == "🥽 AR / VR Integration":
    page_header("AR / VR Integration", "cult")

    st.info("🥽 **Meta Quest & AR Glasses Integration** — Live facility monitoring through Meta Quest Pro, Quest 3, or Ray-Ban Meta Smart Glasses. Walk your rooms with real-time plant data overlays.")

    c1, c2, c3 = st.columns(3)
    c1.button("● Start Live Session", use_container_width=True)
    c2.button("⏺ Start Recording", use_container_width=True)
    c3.button("📁 View Recordings", use_container_width=True)

    st.divider()
    st.markdown("#### Live Feed Features")
    for f in [
        "Real-time plant count overlay per table",
        "Arroyo sensor data (temp, RH, CO₂, VPD) in AR",
        "Harvest stage progress bars per strain",
        "Alert indicators for environmental deviation",
        "Plant health flagging via color-coded heatmap",
    ]:
        st.markdown(f"✓ {f}")

    st.divider()
    st.markdown("#### Connected Devices")
    editable("devices", {
        "name": st.column_config.TextColumn("Device"),
        "type": st.column_config.TextColumn("Type"),
        "status": st.column_config.SelectboxColumn("Status", options=["online", "offline"]),
        "last": st.column_config.TextColumn("Last Connected"),
        "fw": st.column_config.TextColumn("Firmware"),
    })

elif page == "📦 Inventory":
    page_header("Inventory", "dist")

    inv = st.session_state.inventory
    total_avail = inv["available"].fillna(0).sum() if len(inv) else 0
    total_consign = inv["onConsignment"].fillna(0).sum() if len(inv) else 0
    est_value = (inv["available"].fillna(0) * inv["costPerG"].fillna(0)).sum() if len(inv) else 0

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total SKUs", len(inv))
    c2.metric("Available (g)", f"{int(total_avail):,}")
    c3.metric("On Consignment (g)", f"{int(total_consign):,}")
    c4.metric("Est. Inventory Value", f"${est_value:,.0f}")

    st.divider()
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
    page_header("Sales", "dist")

    s = st.session_state.sales
    total = s["total"].fillna(0).sum() if len(s) else 0
    avg_ticket = total / len(s) if len(s) else 0
    pending = s[s["status"] == "pending"]["total"].fillna(0).sum() if len(s) and "status" in s.columns else 0

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total Revenue", f"${total:,.2f}")
    c2.metric("Transactions", len(s))
    c3.metric("Avg Ticket", f"${avg_ticket:,.2f}")
    c4.metric("Pending Payments", f"${pending:,.2f}")

    st.divider()
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
    page_header("Consignment", "dist")

    c = st.session_state.consignments
    active = c[c["status"] == "active"] if len(c) and "status" in c.columns else pd.DataFrame()
    out_g = c["weightOut"].fillna(0).sum() if len(c) else 0
    sold_g = c["weightSold"].fillna(0).sum() if len(c) else 0
    outstanding = 0
    if len(active):
        outstanding = ((active["weightOut"].fillna(0) - active["weightSold"].fillna(0)) * active["pricePerG"].fillna(0)).sum()

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Active", len(active))
    col2.metric("Total Out (g)", int(out_g))
    col3.metric("Total Sold (g)", int(sold_g))
    col4.metric("Outstanding Value", f"${outstanding:,.2f}")

    st.divider()
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
    page_header("Clients", "dist")

    cl = st.session_state.clients
    ytd = cl["ytdPurchases"].fillna(0).sum() if len(cl) else 0
    bal = cl["balance"].fillna(0).sum() if len(cl) else 0
    prem = (cl["tier"] == "premium").sum() if len(cl) and "tier" in cl.columns else 0

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total Clients", len(cl))
    c2.metric("YTD Revenue", f"${ytd:,.0f}")
    c3.metric("Open Balances", f"${bal:,.2f}")
    c4.metric("Premium Accounts", int(prem))

    st.divider()
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
    page_header("Vendors", "dist")
    editable("vendors", {
        "name": st.column_config.TextColumn("Vendor", required=True),
        "category": st.column_config.TextColumn("Category"),
        "ytdSpend": st.column_config.NumberColumn("YTD Spend ($)", min_value=0, format="$%.2f"),
        "lastOrder": st.column_config.DateColumn("Last Order"),
        "terms": st.column_config.TextColumn("Terms"),
    })

elif page == "🚚 Shipping":
    page_header("Shipping", "dist")
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
