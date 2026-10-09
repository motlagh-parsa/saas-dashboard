# SaaS Metrics Dashboard

## Stack
- Next.js 16 App Router, TypeScript
- Tailwind + shadcn/ui (Base UI, Nova preset)
- Prisma + PostgreSQL
- NextAuth
- Recharts

## Rules
- Server Components by default; "use client" only when needed
- All types explicit, no `any`
- shadcn components from @/components/ui
- Prisma client singleton from @/lib/prisma

## Project structure
No `src/` directory. Paths are `app/`, `components/`, `lib/` at the repo root.
- `components/ui/` is shadcn-generated — do not hand-edit
- Prisma client singleton lives at `lib/prisma.ts`

## Reference
Read `PRD.md` before implementing any feature, and `docs/ROADMAP.md` for what is done and what is next.
