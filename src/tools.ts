/**
 * In-process MCP tools exposed to the agent.
 *
 * This is the mechanism the Agent SDK provides in place of the harness-level
 * scheduling tools it does not ship: the tool is declared here, the agent calls
 * it, and the implementation runs in *this* process — where the timer, the
 * database, and the limits already live.
 *
 * The server is built per channel so `channelId` can be closed over. The agent
 * therefore cannot schedule a wake into a channel it is not currently serving,
 * without us having to trust a channel ID it supplies.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { describeCadence, ScheduleRejected, type Scheduler } from './scheduler.js';
import type { Schedule } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function failed(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Route ScheduleRejected back to the agent as a readable tool error. */
async function attempt(run: () => Schedule | string): Promise<ReturnType<typeof ok>> {
  try {
    const result = run();
    return ok(typeof result === 'string' ? result : formatCreated(result));
  } catch (error) {
    if (error instanceof ScheduleRejected) return failed(`Rejected: ${error.message}`);
    return failed(`Failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatCreated(schedule: Schedule): string {
  return [
    `Scheduled (${describeCadence(schedule)}).`,
    `id: ${schedule.id}`,
    `next run: ${new Date(schedule.nextRunAt).toISOString()}`,
    '',
    'When it fires you will be woken with the prompt you supplied. There will be',
    'no message to reply to, so post with `discord send -c <channel_id>`.',
  ].join('\n');
}

export function createSchedulerServer(channelId: string, scheduler: Scheduler) {
  return createSdkMcpServer({
    name: 'clawcius-scheduler',
    version: '0.1.0',
    tools: [
      tool(
        'schedule_wake',
        'Wake yourself once after a delay, to continue work or follow up later. ' +
          'The wake carries the prompt you supply, so write it as an instruction ' +
          'to your future self — it will not have this conversation in view unless ' +
          'the session is still alive.',
        {
          delay_seconds: z
            .number()
            .int()
            .positive()
            .describe('Seconds from now. Subject to a configured minimum.'),
          prompt: z
            .string()
            .min(1)
            .describe('What to do when woken. Be specific and self-contained.'),
        },
        async (args) =>
          attempt(() => scheduler.createOneShot(channelId, args.delay_seconds, args.prompt)),
      ),

      tool(
        'schedule_repeating',
        'Wake yourself on a recurring basis. Supply exactly one of interval_seconds ' +
          'or daily_at. Use this for standing routines such as a morning briefing.',
        {
          prompt: z.string().min(1).describe('What to do on each wake.'),
          interval_seconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Repeat every N seconds.'),
          daily_at: z
            .string()
            .optional()
            .describe('Repeat daily at HH:MM, 24-hour, server local time.'),
        },
        async (args) => {
          const hasInterval = args.interval_seconds !== undefined;
          const hasDaily = args.daily_at !== undefined;
          if (hasInterval === hasDaily) {
            return failed('Supply exactly one of interval_seconds or daily_at.');
          }
          return attempt(() =>
            hasDaily
              ? scheduler.createDaily(channelId, args.daily_at as string, args.prompt)
              : scheduler.createInterval(
                  channelId,
                  args.interval_seconds as number,
                  args.prompt,
                ),
          );
        },
      ),

      tool(
        'list_schedules',
        'List the wakes currently scheduled for this channel, with their ids.',
        {},
        async () => {
          const schedules = scheduler.list(channelId);
          if (schedules.length === 0) return ok('No schedules for this channel.');
          return ok(
            schedules
              .map(
                (s) =>
                  `${s.id}  ${describeCadence(s).padEnd(18)} ` +
                  `next ${new Date(s.nextRunAt).toISOString()}  ${s.prompt.slice(0, 60)}`,
              )
              .join('\n'),
          );
        },
      ),

      tool(
        'cancel_schedule',
        'Cancel a scheduled wake by id. Use list_schedules to find the id.',
        { schedule_id: z.string().min(1).describe('Id from list_schedules.') },
        async (args) =>
          attempt(() =>
            scheduler.cancel(channelId, args.schedule_id)
              ? `Cancelled ${args.schedule_id}.`
              : `No schedule ${args.schedule_id} in this channel.`,
          ),
      ),
    ],
  });
}
