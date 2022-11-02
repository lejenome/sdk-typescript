import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fetchWorkflowHistory } from '@temporalio/worker/lib/replay';
import { randomUUID } from 'crypto';
import { test, bundlerOptions, ByteSkewerPayloadCodec } from './helpers';
import {
  DefaultFailureConverter,
  ApplicationFailure,
  DataConverter,
  DefaultEncodedFailureAttributes,
} from '@temporalio/common';
import { proxyActivities } from '@temporalio/workflow';
import { WorkflowFailedError } from '@temporalio/client';
import { decodeFromPayloadsAtIndex } from '@temporalio/common/lib/internal-non-workflow';

export const failureConverter = new DefaultFailureConverter({ encodeCommonAttributes: true });

class Activities {
  public raise = async () => {
    throw ApplicationFailure.nonRetryable('error message');
  };
}

export async function workflow(): Promise<void> {
  const activities = proxyActivities<Activities>({ startToCloseTimeout: '1m' });
  await activities.raise();
}

test('Client and Worker use provided failureConverter', async (t) => {
  const dataConverter: DataConverter = {
    // Use a payload codec to verify that it's being utilized to encode / decode the failure
    payloadCodecs: [new ByteSkewerPayloadCodec()],
    failureConverterPath: __filename,
  };
  const env = await TestWorkflowEnvironment.createLocal({ client: { dataConverter } });
  try {
    const info = await env.connection.workflowService.getSystemInfo({});
    if (!info.capabilities?.encodedFailureAttributes) {
      t.pass('Skipped test for lack of encodedFailureAttributes capability');
      return;
    }

    const taskQueue = 'test';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      activities: new Activities(),
      workflowsPath: __filename,
      taskQueue,
      dataConverter,
      bundlerOptions,
    });

    // Run the workflow, expect error with message and stack trace
    const handle = await env.client.workflow.start(workflow, { taskQueue, workflowId: randomUUID() });
    const err = (await worker.runUntil(t.throwsAsync(handle.result()))) as WorkflowFailedError;
    console.log(err);
    t.is(err.cause?.message, 'Activity execution failed');
    t.is(err.cause?.cause?.message, 'error message');
    t.true(err.cause?.cause?.stack?.startsWith('ApplicationFailure: error message\n'));

    // Verify failure was indeed encoded
    const { events } = await fetchWorkflowHistory(env.client, handle.workflowId);
    const { failure } = events?.[events.length - 1].workflowExecutionFailedEventAttributes ?? {};
    {
      const payload = failure?.encodedAttributes;
      const attrs = await decodeFromPayloadsAtIndex<DefaultEncodedFailureAttributes>(
        env.client.options.loadedDataConverter,
        0,
        payload ? [payload] : undefined
      );
      t.is(failure?.message, 'Encoded failure');
      t.is(failure?.stackTrace, '');
      t.is(attrs.message, 'Activity task failed'); // Hmmm..
      t.is(attrs.stack_trace, '');
    }
    {
      const payload = failure?.cause?.encodedAttributes;
      const attrs = await decodeFromPayloadsAtIndex<DefaultEncodedFailureAttributes>(
        env.client.options.loadedDataConverter,
        0,
        payload ? [payload] : undefined
      );
      t.is(failure?.cause?.message, 'Encoded failure');
      t.is(failure?.stackTrace, '');
      t.is(attrs.message, 'error message');
      t.true(attrs.stack_trace.startsWith('ApplicationFailure: error message\n'));
    }
  } finally {
    await env.teardown();
  }
});
