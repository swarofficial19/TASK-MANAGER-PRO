import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { execSync } from 'child_process';
import { createServer as createViteServer } from 'vite';
import { db } from './server/db.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Port 3000 is required for AI Studio dev server and nginx reverse proxy
const PORT = 3000;

app.use(express.json());

// CORS & Preflight headers for cross-origin or iframe embedding
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Helper to get today's date formatted as YYYY-MM-DD
function getTodayString(): string {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

// Interfaces
interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  priority: 'Low' | 'Medium' | 'High';
  status: 'Pending' | 'In Progress' | 'Completed';
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

// -------------------------------------------------------------
// REST API ENDPOINTS
// -------------------------------------------------------------

// 1. GET /api/stats - Dashboard Statistics
app.get('/api/stats', (req: Request, res: Response) => {
  try {
    const today = getTodayString();

    const total = (db.prepare('SELECT count(*) as count FROM tasks').get() as { count: number }).count;
    const completed = (db.prepare("SELECT count(*) as count FROM tasks WHERE status = 'Completed'").get() as { count: number }).count;
    const pending = (db.prepare("SELECT count(*) as count FROM tasks WHERE status = 'Pending'").get() as { count: number }).count;
    const inProgress = (db.prepare("SELECT count(*) as count FROM tasks WHERE status = 'In Progress'").get() as { count: number }).count;

    const overdue = (db.prepare(`
      SELECT count(*) as count FROM tasks 
      WHERE due_date IS NOT NULL AND due_date != '' AND due_date < ? AND status != 'Completed'
    `).get(today) as { count: number }).count;

    const dueToday = (db.prepare(`
      SELECT count(*) as count FROM tasks 
      WHERE due_date = ? AND status != 'Completed'
    `).get(today) as { count: number }).count;

    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Priority breakdown
    const priorityRows = db.prepare(`
      SELECT priority, count(*) as count FROM tasks GROUP BY priority
    `).all() as Array<{ priority: string; count: number }>;

    const priorityCounts: Record<string, number> = { High: 0, Medium: 0, Low: 0 };
    for (const row of priorityRows) {
      priorityCounts[row.priority] = row.count;
    }

    // Upcoming deadlines (next 5 urgent incomplete tasks)
    const upcomingDeadlines = db.prepare(`
      SELECT * FROM tasks 
      WHERE status != 'Completed' AND due_date IS NOT NULL AND due_date != ''
      ORDER BY due_date ASC, CASE priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END ASC
      LIMIT 5
    `).all() as TaskRow[];

    // Recent tasks (last 5 created/updated)
    const recentTasks = db.prepare(`
      SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 5
    `).all() as TaskRow[];

    // Completion distribution by status
    const statusBreakdown = [
      { name: 'Completed', count: completed, percentage: total > 0 ? Math.round((completed / total) * 100) : 0 },
      { name: 'In Progress', count: inProgress, percentage: total > 0 ? Math.round((inProgress / total) * 100) : 0 },
      { name: 'Pending', count: pending, percentage: total > 0 ? Math.round((pending / total) * 100) : 0 },
    ];

    res.json({
      totalTasks: total,
      completedTasks: completed,
      pendingTasks: pending,
      inProgressTasks: inProgress,
      overdueTasks: overdue,
      dueTodayTasks: dueToday,
      completionRate,
      priorityCounts,
      upcomingDeadlines,
      recentTasks,
      statusBreakdown
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to retrieve stats';
    res.status(500).json({ error: message });
  }
});

// 2. GET /api/tasks - Retrieve tasks with filtering, search, and sorting
app.get('/api/tasks', (req: Request, res: Response) => {
  try {
    const {
      search,
      priority,
      status,
      view,
      sortBy = 'due_date',
      order = 'asc'
    } = req.query;

    const today = getTodayString();
    let query = 'SELECT * FROM tasks WHERE 1=1';
    const params: (string | number)[] = [];

    // Search filter
    if (search && typeof search === 'string' && search.trim() !== '') {
      query += ' AND (title LIKE ? OR description LIKE ?)';
      const s = `%${search.trim()}%`;
      params.push(s, s);
    }

    // View presets
    if (view === 'my_day') {
      query += ' AND due_date = ?';
      params.push(today);
    } else if (view === 'upcoming') {
      query += " AND due_date > ? AND status != 'Completed'";
      params.push(today);
    } else if (view === 'completed') {
      query += " AND status = 'Completed'";
    } else if (view === 'overdue') {
      query += " AND due_date IS NOT NULL AND due_date != '' AND due_date < ? AND status != 'Completed'";
      params.push(today);
    }

    // Priority filter
    if (priority && priority !== 'all' && ['Low', 'Medium', 'High'].includes(priority as string)) {
      query += ' AND priority = ?';
      params.push(priority as string);
    }

    // Status filter
    if (status && status !== 'all' && ['Pending', 'In Progress', 'Completed'].includes(status as string)) {
      query += ' AND status = ?';
      params.push(status as string);
    }

    // Sorting
    const sortDirection = order === 'desc' ? 'DESC' : 'ASC';
    if (sortBy === 'priority') {
      const dir = sortDirection === 'DESC' ? 'DESC' : 'ASC';
      query += ` ORDER BY CASE priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END ${dir}, due_date ASC`;
    } else if (sortBy === 'title') {
      query += ` ORDER BY title COLLATE NOCASE ${sortDirection}`;
    } else if (sortBy === 'created_at') {
      query += ` ORDER BY created_at ${sortDirection}`;
    } else {
      // default: due_date
      query += ` ORDER BY CASE WHEN due_date IS NULL OR due_date = '' THEN 1 ELSE 0 END, due_date ${sortDirection}, created_at DESC`;
    }

    const tasks = db.prepare(query).all(...params) as TaskRow[];
    res.json(tasks);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to query tasks';
    res.status(500).json({ error: message });
  }
});

// 3. GET /api/categories - Empty array for legacy compatibility
app.get('/api/categories', (_req: Request, res: Response) => {
  res.json([]);
});

// 4. GET /api/tasks/:id - Retrieve single task
app.get('/api/tasks/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid task ID format' });
      return;
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!task) {
      res.status(404).json({ error: `Task with ID ${id} not found` });
      return;
    }

    res.json(task);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to retrieve task';
    res.status(500).json({ error: message });
  }
});

// 5. POST /api/tasks - Create a task
app.post('/api/tasks', (req: Request, res: Response) => {
  try {
    const { title, description, priority = 'Medium', status = 'Pending', due_date } = req.body || {};

    if (!title || typeof title !== 'string' || title.trim() === '') {
      res.status(400).json({ error: 'Task title is required and cannot be empty' });
      return;
    }

    if (!['Low', 'Medium', 'High'].includes(priority)) {
      res.status(400).json({ error: 'Priority must be one of: Low, Medium, High' });
      return;
    }

    if (!['Pending', 'In Progress', 'Completed'].includes(status)) {
      res.status(400).json({ error: 'Status must be one of: Pending, In Progress, Completed' });
      return;
    }

    const cleanTitle = title.trim();
    const cleanDesc = description && typeof description === 'string' ? description.trim() : null;
    const cleanDueDate = due_date && typeof due_date === 'string' && due_date.trim() !== '' ? due_date.trim() : null;
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO tasks (title, description, priority, status, due_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(cleanTitle, cleanDesc, priority, status, cleanDueDate, now, now);
    const newId = Number(result.lastInsertRowid);
    const newTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(newId) as TaskRow;

    res.status(201).json(newTask);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create task';
    res.status(500).json({ error: message });
  }
});

// 6. PUT /api/tasks/:id - Update an existing task
app.put('/api/tasks/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid task ID format' });
      return;
    }

    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!existing) {
      res.status(404).json({ error: `Task with ID ${id} not found` });
      return;
    }

    const { title, description, priority, status, due_date } = req.body || {};

    if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
      res.status(400).json({ error: 'Task title cannot be empty' });
      return;
    }

    if (priority !== undefined && !['Low', 'Medium', 'High'].includes(priority)) {
      res.status(400).json({ error: 'Invalid priority. Must be Low, Medium, or High' });
      return;
    }

    if (status !== undefined && !['Pending', 'In Progress', 'Completed'].includes(status)) {
      res.status(400).json({ error: 'Invalid status. Must be Pending, In Progress, or Completed' });
      return;
    }

    const updatedTitle = title !== undefined ? title.trim() : existing.title;
    const updatedDesc = description !== undefined ? (typeof description === 'string' && description.trim() !== '' ? description.trim() : null) : existing.description;
    const updatedPriority = priority !== undefined ? priority : existing.priority;
    const updatedStatus = status !== undefined ? status : existing.status;
    const updatedDueDate = due_date !== undefined ? (due_date && typeof due_date === 'string' && due_date.trim() !== '' ? due_date.trim() : null) : existing.due_date;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE tasks 
      SET title = ?, description = ?, priority = ?, status = ?, due_date = ?, updated_at = ?
      WHERE id = ?
    `).run(updatedTitle, updatedDesc, updatedPriority, updatedStatus, updatedDueDate, now, id);

    const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
    res.json(updatedTask);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to update task';
    res.status(500).json({ error: message });
  }
});

// 7. PATCH /api/tasks/:id/status - Quick status toggle or drag-and-drop column move
app.patch('/api/tasks/:id/status', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid task ID format' });
      return;
    }

    const { status } = req.body || {};
    if (!status || !['Pending', 'In Progress', 'Completed'].includes(status)) {
      res.status(400).json({ error: 'Status must be one of: Pending, In Progress, Completed' });
      return;
    }

    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!existing) {
      res.status(404).json({ error: `Task with ID ${id} not found` });
      return;
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to update task status';
    res.status(500).json({ error: message });
  }
});

// 8. DELETE /api/tasks/:id - Delete a task
app.delete('/api/tasks/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid task ID format' });
      return;
    }

    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!existing) {
      res.status(404).json({ error: `Task with ID ${id} not found` });
      return;
    }

    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    res.json({ success: true, message: 'Task deleted successfully', deletedTask: existing });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to delete task';
    res.status(500).json({ error: message });
  }
});

// 9. GET /api/export-repo - Download clean ZIP bundle of repository for GitHub submission
app.get('/api/export-repo', (req: Request, res: Response) => {
  try {
    const archivePath = path.join('/tmp', `taskflow-repository-${Date.now()}.zip`);
    execSync(`git archive --format=zip --output="${archivePath}" HEAD`, { cwd: __dirname });

    res.download(archivePath, 'task-list-application-repository.zip', (err) => {
      try {
        if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
      } catch {
        // ignore
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate repository zip';
    res.status(500).json({ error: message });
  }
});

// Ensure any unknown /api route returns JSON error instead of HTML
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
});

// -------------------------------------------------------------
// VITE DEV SERVER / PRODUCTION STATIC SERVING
// -------------------------------------------------------------
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TaskFlow Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
