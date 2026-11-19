import type { ReactNode } from "react"
import { NavLinks } from "@/components/NavLinks"
import { ProfileMenu } from "@/components/ProfileMenu"
import { BASE_PATH } from "@/lib/ui/api"

// Authenticated app chrome, modelled on AgentHub's: top header (MFEC logo + "BSM MIDHub" wordmark, profile
// menu) and a section-tab row. Unlike AgentHub it stays visible on phones (MidHub is used on mobile).
// The logos are AgentHub's own PNGs (public/); the wordmark is text. basePath is /midhub, so <img> needs it spelled out.
export function AppChrome({ user, children }: { user: { email: string; role: string }; children: ReactNode }) {
  const isAdmin = user.role === "admin"
  return (
    <div className="min-h-svh flex flex-col bg-gray-50 dark:bg-neutral-900">
      <header className="relative shrink-0 flex items-center px-5 py-1.5 bg-white border-b border-gray-200 shadow-sm dark:bg-neutral-800 dark:border-neutral-700">
        {/* Logo swaps by theme via CSS: black on light, white on dark. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${BASE_PATH}/logo-mfec-black.png`} alt="MFEC" className="h-7 w-auto self-center -mt-1.5 dark:hidden" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${BASE_PATH}/logo-mfec-white.png`} alt="MFEC" className="h-7 w-auto self-center -mt-1.5 hidden dark:block" />
        <span className="self-center h-6 w-px bg-gray-200 dark:bg-neutral-700 mx-2" />
        {/* The BSM gradient is AgentHub's sanctioned brand-identity gradient. */}
        <span className="relative -top-px text-2xl md:text-[31px] leading-8 md:leading-9 font-bold tracking-tight text-gray-900 dark:text-neutral-50">
          <span className="bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-500 bg-clip-text text-transparent">BSM</span> <span className="text-blue-600 dark:text-blue-400">MIDHub</span>
        </span>
        <div className="ml-auto">
          <ProfileMenu email={user.email} role={user.role} />
        </div>
      </header>
      <nav aria-label="Main" className="shrink-0 h-11 flex items-center gap-5 md:gap-7 px-4 md:px-8 overflow-x-auto bg-gray-50/80 border-b border-gray-200 dark:bg-neutral-900 dark:border-neutral-700">
        <NavLinks isAdmin={isAdmin} />
      </nav>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
