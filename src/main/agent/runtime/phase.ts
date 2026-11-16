import type { TaskClass } from '../../llm/task-classifier'
import type { RunPhase } from './store'

/** A phase changes its resource needs, without discarding the task's stakes or constraints. */
export function phaseTask(task: TaskClass, phase: RunPhase): TaskClass {
  const category = phase === 'research' ? 'research' : phase === 'write' && !['coding', 'office', 'cad'].includes(task.category) ? 'writing' : task.category
  return { ...task, category, effort: phase === 'verify' ? 'high' : phase === 'research' && task.difficulty <= 1 ? 'medium' : task.effort, why: `${task.why} · ${phase} phase` }
}
