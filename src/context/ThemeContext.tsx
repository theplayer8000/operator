import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRemoteStorage } from "@/hooks/useRemoteStorage";

export type AccentColor = "gold" | "violet" | "cyan" | "coral";

const ACCENT_HEX: Record<AccentColor, string> = {
  gold: "#E8B04D",
  violet: "#8D7FE0",
  cyan: "#4FB4C7",
  coral: "#D9685F",
};

interface ThemeContextValue {
  accent: AccentColor;
  setAccent: (a: AccentColor) => void;
  accentHex: string;
  /** Desktop only — collapses the rail to icons. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Mobile only — the nav drawer. */
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [accent, setAccent] = useRemoteStorage<AccentColor>("theme.accent", "gold");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", ACCENT_HEX[accent]);
  }, [accent]);

  return (
    <ThemeContext.Provider
      value={{
        accent,
        setAccent,
        accentHex: ACCENT_HEX[accent],
        sidebarCollapsed,
        toggleSidebar: () => setSidebarCollapsed((v) => !v),
        mobileNavOpen,
        setMobileNavOpen,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
