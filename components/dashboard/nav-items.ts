import {
  Activity,
  Bell,
  FileText,
  LayoutDashboard,
  Receipt,
  ScrollText,
  Settings,
  Tags,
  TrendingUp,
  UserCog,
  Users,
} from "lucide-react";
import type { ComponentType } from "react";

export type NavItem = {
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  /** Optional trailing count, e.g. unread notifications. */
  count?: number;
};

/** The one nav entry that carries a live count. Exported so the nav can find it. */
export const NOTIFICATIONS_HREF = "/dashboard/notifications";

// Grounded in the operator's job: watch revenue, then act on customers.
export const primaryNav: NavItem[] = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { label: "Revenue", href: "/dashboard/revenue", icon: TrendingUp },
  { label: "Customers", href: "/dashboard/customers", icon: Users },
  // The billing data behind every number: what is sold, and what was billed.
  { label: "Plans", href: "/dashboard/plans", icon: Tags },
  { label: "Invoices", href: "/dashboard/invoices", icon: Receipt },
  { label: "Retention", href: "/dashboard/retention", icon: Activity },
  { label: "Reports", href: "/dashboard/reports", icon: FileText },
];

export const secondaryNav: NavItem[] = [
  // No `count` here on purpose: the unread total is real data now, read on the
  // server in `app/(dashboard)/layout.tsx` and passed into `SidebarNav`. A
  // hardcoded number in a module constant would go stale the moment anything is
  // marked read, and would disagree with the bell two inches away.
  // UserCog, not Users: Customers above already wears Users, and two identical
  // glyphs in one rail make the icons useless for scanning.
  { label: "Users", href: "/dashboard/users", icon: UserCog },
  { label: "Audit Log", href: "/dashboard/audit", icon: ScrollText },
  { label: "Notifications", href: NOTIFICATIONS_HREF, icon: Bell },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
];