// ‌‍‌‌‍‌‍‍‌‌‍‍‌‍‌‍‍‍‌‌‍‍‍‌‌‍‌‍‍‌‌‍‌‍‍‌‍‌‌‍‍‌‌‌‍‍‌‌‍‌‌‍‌‍‌‍‌‌‍‌
// Skales v5.0.0 — BSL 1.1 — Mario Simic
// ‌‍‌‌‍‌‍‍‌‌‍‍‌‍‌‍‍‍‌‌‍‍‍‌‌‍‌‍‍‌‌‍‌‍‍‌‍‌‌‍‍‌‌‌‍‍‌‌‍‌‌‍‌‍‌‍‌‌‍‌
import './globals.css';
import { ThemeProvider } from '@/components/providers/theme-provider';
import AppShell from '@/components/app-shell';
import { NotificationManager } from '@/components/system/notification-manager';
import { ErrorBoundary } from '@/components/error-boundary';

export const metadata = {
    title: 'Skales — Your AI Buddy',
    description: 'Your personal autonomous AI assistant. Simple. Smart. Private.',
    icons: {
        icon: [
            { url: '/favicon.ico', type: 'image/x-icon' },
        ],
        shortcut: '/favicon.ico',
    },
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                {/* Blocking theme script: runs before body renders to prevent flash */}
                <script dangerouslySetInnerHTML={{ __html: `
                    (function() {
                        try {
                            var stored = localStorage.getItem('theme');
                            var theme = stored === 'light' ? 'light' : stored === 'dark' ? 'dark' : 'dark';
                            if (!stored) {
                                var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                                theme = prefersDark ? 'dark' : 'light';
                            }
                            document.documentElement.classList.remove('light', 'dark');
                            document.documentElement.classList.add(theme);
                        } catch(e) {
                            document.documentElement.classList.add('dark');
                        }
                    })();
                ` }} />
            </head>
            <body suppressHydrationWarning>
                {/* Skip-to-main: visible only on keyboard focus (Tab from address bar) */}
                <a href="#main-content" className="skip-to-main">
                    Skip to main content
                </a>
                <ThemeProvider
                    attribute="class"
                    defaultTheme="dark"
                    enableSystem
                    disableTransitionOnChange
                >
                    <ErrorBoundary>
                        <AppShell>
                            <NotificationManager />
                            {children}
                        </AppShell>
                    </ErrorBoundary>
                </ThemeProvider>
            </body>
        </html>
    );
}
