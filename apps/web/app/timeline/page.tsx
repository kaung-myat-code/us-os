'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthMeResponse, MilestoneCategory, MilestoneResponse } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

const CATEGORIES: MilestoneCategory[] = ['milestone', 'memory', 'decision', 'other'];

export default function TimelinePage() {
  const router = useRouter();
  const [entries, setEntries] = useState<MilestoneResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [category, setCategory] = useState<MilestoneCategory>('other');
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<MilestoneResponse[]>('/milestones'))
      .then(setEntries)
      .catch(() => router.push('/login'));
  }, [router]);

  function resetForm() {
    setTitle('');
    setEventDate('');
    setCategory('other');
    setNote('');
    setEditingId(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (editingId) {
        const updated = await apiFetch<MilestoneResponse>(`/milestones/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title, eventDate, category, note: note || null }),
        });
        setEntries((prev) => (prev ?? []).map((entry) => (entry.id === editingId ? updated : entry)));
      } else {
        const created = await apiFetch<MilestoneResponse>('/milestones', {
          method: 'POST',
          body: JSON.stringify({ title, eventDate, category, note: note || null }),
        });
        setEntries((prev) =>
          [...(prev ?? []), created].sort((a, b) => a.eventDate.localeCompare(b.eventDate)),
        );
      }
      resetForm();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function handleEdit(entry: MilestoneResponse) {
    setEditingId(entry.id);
    setTitle(entry.title);
    setEventDate(entry.eventDate);
    setCategory(entry.category);
    setNote(entry.note ?? '');
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this entry?')) return;
    setError(null);
    try {
      await apiFetch(`/milestones/${id}`, { method: 'DELETE' });
      setEntries((prev) => (prev ?? []).filter((entry) => entry.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (entries === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Timeline</h1>

      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <strong>{entry.title}</strong> — {entry.eventDate} ({entry.category})
            {entry.note && <p>{entry.note}</p>}
            <button type="button" onClick={() => handleEdit(entry)}>
              Edit
            </button>
            <button type="button" onClick={() => handleDelete(entry.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      <h2>{editingId ? 'Edit entry' : 'Add entry'}</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Title <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Date <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Category{' '}
            <select value={category} onChange={(e) => setCategory(e.target.value as MilestoneCategory)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <label>
            Note <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <button type="submit">{editingId ? 'Save' : 'Add entry'}</button>
        {editingId && (
          <button type="button" onClick={resetForm}>
            Cancel
          </button>
        )}
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
