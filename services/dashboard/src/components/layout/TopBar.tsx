import { useAuth }    from "../../hooks/useAuth";
import { useUiStore } from "../../store/uiStore";

export default function TopBar() {
  const { user, logout } = useAuth();
  const pageTitle        = useUiStore((s) => s.pageTitle);
  const toggle           = useUiStore((s) => s.toggleSidebar);

  return (
    <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 shrink-0">
      {/* Left: hamburger + page title */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          className="p-1.5 rounded-md text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          aria-label="Toggle sidebar"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <h1 className="text-base font-semibold text-slate-800">{pageTitle}</h1>
      </div>

      {/* Right: user identity + sign-out */}
      <div className="flex items-center gap-3">
        {user?.email && (
          <span className="text-sm text-slate-500 hidden sm:block">{user.email}</span>
        )}
        <button
          onClick={() => void logout()}
          className="flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900
                     px-3 py-1.5 rounded-md hover:bg-slate-100 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          <span className="hidden sm:block">Sign out</span>
        </button>
      </div>
    </header>
  );
}
