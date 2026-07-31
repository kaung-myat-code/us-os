'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthMeResponse, GoalCategory, GoalResponse, GoalStatus } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

const CATEGORIES: GoalCategory[] = ['financial', 'health', 'travel', 'career', 'relationship', 'other'];
const STATUSES: GoalStatus[] = ['active', 'achieved', 'abandoned'];

export default function GoalsPage() {
  const router = useRouter();
  const [goals, setGoals] = useState<GoalResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<GoalCategory>('other');
  const [targetDate, setTargetDate] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<GoalResponse[]>('/goals'))
      .then(setGoals)
      .catch(() => router.push('/login'));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiFetch<GoalResponse>('/goals', {
        method: 'POST',
        body: JSON.stringify({
          title,
          category,
          targetDate: targetDate || null,
          description: description || null,
        }),
      });
      setGoals((prev) => [created, ...(prev ?? [])]);
      setTitle('');
      setCategory('other');
      setTargetDate('');
      setDescription('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleProgressChange(goal: GoalResponse, progress: number) {
    setError(null);
    try {
      const updated = await apiFetch<GoalResponse>(`/goals/${goal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ progress }),
      });
      setGoals((prev) => (prev ?? []).map((g) => (g.id === updated.id ? updated : g)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleStatusChange(goal: GoalResponse, status: GoalStatus) {
    setError(null);
    try {
      const updated = await apiFetch<GoalResponse>(`/goals/${goal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setGoals((prev) => (prev ?? []).map((g) => (g.id === updated.id ? updated : g)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(goal: GoalResponse) {
    if (!window.confirm('Delete this goal?')) return;
    setError(null);
    try {
      await apiFetch(`/goals/${goal.id}`, { method: 'DELETE' });
      setGoals((prev) => (prev ?? []).filter((g) => g.id !== goal.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (goals === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Goals</h1>

      <ul>
        {goals.map((goal) => (
          <li key={goal.id}>
            <strong>{goal.title}</strong> — [{goal.category}] — {goal.status}
            {goal.targetDate && <span> — target: {goal.targetDate}</span>}
            {goal.description && <p>{goal.description}</p>}
            <div>
              <label>
                Progress{' '}
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={goal.progress}
                  onChange={(e) => handleProgressChange(goal, Number(e.target.value))}
                />
                %
              </label>
              <select value={goal.status} onChange={(e) => handleStatusChange(goal, e.target.value as GoalStatus)}>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              {goal.achievedAt && <span> achieved: {goal.achievedAt}</span>}
              <button type="button" onClick={() => handleDelete(goal)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2>New goal</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Title <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Category{' '}
            <select value={category} onChange={(e) => setCategory(e.target.value as GoalCategory)}>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <label>
            Target date <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Description <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <button type="submit">Create goal</button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
