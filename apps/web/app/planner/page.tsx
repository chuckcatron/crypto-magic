import type { Metadata } from 'next';
import { Planner } from '@/components/Planner';

export const metadata: Metadata = {
  title: 'Income planner · crypto-magic',
};

export default function PlannerPage() {
  return <Planner />;
}
