import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout       from "./components/layout/AppLayout";
import ProtectedRoute  from "./components/layout/ProtectedRoute";
import Login           from "./pages/Login";
import Dashboard       from "./pages/Dashboard";
import Sites           from "./pages/Sites";
import Inventory       from "./pages/Inventory";
import Moisture        from "./pages/Moisture";
import Alerts          from "./pages/Alerts";
import Settings        from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />

      {/* Protected — all share the AppLayout shell */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard"  element={<Dashboard />} />
          <Route path="/sites"      element={<Sites />} />
          <Route path="/inventory"  element={<Inventory />} />
          <Route path="/moisture"   element={<Moisture />} />
          <Route path="/alerts"     element={<Alerts />} />
          <Route path="/settings"   element={<Settings />} />
        </Route>
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
