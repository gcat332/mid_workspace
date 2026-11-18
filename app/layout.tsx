import "./globals.css"
import type { ReactNode } from "react"
import { themeBootScript } from "@/lib/ui/theme"

export const metadata = {
  title: "BSM MIDHub",
  description: "จัดการ ServiceNow MID Server หลายตัวบนเครื่องเดียว (BSM MIDHub)",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th" suppressHydrationWarning>
      <body className="antialiased bg-gray-50 text-gray-900 dark:bg-neutral-900 dark:text-neutral-100" suppressHydrationWarning>
        {/* Runs before paint: applies the saved light/dark preference so there is no flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {children}
      </body>
    </html>
  )
}
