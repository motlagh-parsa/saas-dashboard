import {
  Activity,
  Bell,
  FileText,
  LayoutDashboard,
  Settings,
  TrendingUp,
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

// Grounded in the operator's job: watch revenue, then act on customers.
export const primaryNav: NavItem[] = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { label: "Revenue", href: "/dashboard/revenue", icon: TrendingUp },
  { label: "Customers", href: "/dashboard/customers", icon: Users },
  { label: "Retention", href: "/dashboard/retention", icon: Activity },
  { label: "Reports", href: "/dashboard/reports", icon: FileText },
];

export const secondaryNav: NavItem[] = [
  { label: "Notifications", href: "/dashboard/notifications", icon: Bell, count: 3 },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
];