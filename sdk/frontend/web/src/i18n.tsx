import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

// The workbench is English-only. The provider/hook shape is kept so components
// keep one `text()` entry point for interface copy, which is where a future
// localisation layer would plug back in.
export type UiLanguage = 'en';

type UiLanguageContextValue = {
  language: UiLanguage;
  text: (en: string) => string;
};

const UiLanguageContext = createContext<UiLanguageContextValue | null>(null);

export function UiLanguageProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = 'en';
  }, []);

  const value = useMemo<UiLanguageContextValue>(() => ({
    language: 'en',
    text: (en) => en,
  }), []);

  return <UiLanguageContext.Provider value={value}>{children}</UiLanguageContext.Provider>;
}

export function useUiLanguage(): UiLanguageContextValue {
  const value = useContext(UiLanguageContext);
  if (!value) throw new Error('useUiLanguage must be used inside UiLanguageProvider');
  return value;
}

export function uiText(_language: UiLanguage, en: string): string {
  return en;
}
