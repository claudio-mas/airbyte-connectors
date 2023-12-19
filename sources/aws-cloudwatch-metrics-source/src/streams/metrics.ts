import {createHash} from 'crypto';
import {
  AirbyteLogger,
  AirbyteStreamBase,
  StreamKey,
  SyncMode,
} from 'faros-airbyte-cdk';
import _ from 'lodash';
import {Dictionary} from 'ts-essentials';

import {
  CloudWatch,
  Config,
  DataPoint,
  MIN_DATE,
  NamedQuery,
} from '../cloudwatch';

const DEFAULT_STREAM_NAME = 'metrics';

type StreamState = {
  [queryName: string]: {[queryHash: string]: {timestamp: string}};
};
type StreamSlice = {
  query: NamedQuery;
  queryHash: string;
};

export class Metrics extends AirbyteStreamBase {
  private state: StreamState;

  constructor(
    private readonly config: Config,
    protected readonly logger: AirbyteLogger
  ) {
    super(logger);
  }

  get name(): string {
    return this.config.stream_name ?? DEFAULT_STREAM_NAME;
  }

  getJsonSchema(): Dictionary<any, string> {
    return require('../../resources/schemas/metrics.json');
  }

  get primaryKey(): StreamKey {
    return undefined;
  }

  get cursorField(): string | string[] {
    return ['queryName', 'timestamp'];
  }

  async *streamSlices(): AsyncGenerator<StreamSlice> {
    for (const query of this.config.queries) {
      const queryHash = createHash('md5')
        .update(CloudWatch.toQueryString(query.query))
        .digest('hex');
      yield {query, queryHash};
    }
  }

  async *readRecords(
    syncMode: SyncMode,
    cursorField?: string[],
    streamSlice?: StreamSlice,
    streamState?: StreamState
  ): AsyncGenerator<{queryName: string} & DataPoint> {
    this.state = syncMode === SyncMode.INCREMENTAL ? streamState ?? {} : {};

    const timestamp = _.get(this.state, [
      streamSlice?.query.name,
      streamSlice?.queryHash,
      'timestamp',
    ]);
    const cloudWatch = CloudWatch.instance(this.config);

    if (!_.has(this.state, [streamSlice?.query.name, streamSlice?.queryHash])) {
      _.set(this.state, [streamSlice?.query.name, streamSlice?.queryHash], {
        timestamp: MIN_DATE,
      });
    }

    for await (const record of cloudWatch.getMetricData(
      streamSlice?.query.query,
      timestamp,
      this.logger
    )) {
      const queryTimestamp =
        this.state?.[streamSlice?.query.name][streamSlice?.queryHash]
          ?.timestamp;
      const latestRecordTimestamp = record?.timestamp ?? MIN_DATE;
      if (new Date(latestRecordTimestamp) > new Date(queryTimestamp)) {
        this.state[streamSlice?.query.name][streamSlice?.queryHash] = {
          timestamp: latestRecordTimestamp,
        };
      }
      yield {queryName: streamSlice?.query.name, ...record};
    }
  }

  getUpdatedState(): StreamState {
    return this.state;
  }
}
