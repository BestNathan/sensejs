import {Consumer, ConsumerConfig, EachBatchPayload, Kafka, KafkaMessage as KafkaJsMessage} from 'kafkajs';
import {WorkerController} from './worker-synchronizer';
import {createKafkaClient} from './create-client';
import {KafkaBatchConsumeMessageParam, KafkaClientOption, KafkaReceivedMessage} from './types';

export type KafkaFetchOption = ConsumerConfig;

export interface KafkaCommitOption {
  commitInterval: number;
}

export interface MessageConsumerOption extends KafkaClientOption {
  fetchOption: KafkaFetchOption;
  commitOption?: KafkaCommitOption;
}

export interface MessageConsumeCallback {
  (message: KafkaReceivedMessage): Promise<void>;
}

export interface BatchMessageConsumeCallback {
  (message: KafkaBatchConsumeMessageParam): Promise<void>;
}

export interface SimpleConsumeOption {
  type: 'simple';
  consumer: MessageConsumeCallback;
  fromBeginning: boolean;
}

export interface BatchConsumeOption {
  type: 'batch';
  consumer: BatchMessageConsumeCallback;
  fromBeginning?: boolean;
  autoResolveBatch?: boolean;
}

export interface BatchSubscribeOption {
  topic: string;
  consumer: BatchMessageConsumeCallback;
  fromBeginning?: boolean;
  autoResolve?: boolean;
}

type ConsumeOption = SimpleConsumeOption | BatchConsumeOption;

export class MessageConsumer {
  private client: Kafka;
  private consumer: Consumer;
  private consumeOptions: Map<string, ConsumeOption> = new Map();
  private runPromise?: Promise<unknown>;
  private workerController = new WorkerController<boolean>();
  private startedPromise?: Promise<void>;
  private stoppedPromise?: Promise<void>;
  private commitOption?: KafkaCommitOption;
  public readonly consumerGroupId;

  constructor(option: MessageConsumerOption) {
    this.client = createKafkaClient(option);
    this.consumer = this.client.consumer(option.fetchOption);
    this.commitOption = option.commitOption;
    this.consumerGroupId = option.fetchOption.groupId;
  }

  subscribe(topic: string, consumer: MessageConsumeCallback, fromBeginning: boolean = false): this {
    this.consumeOptions.set(topic, {type: 'simple', consumer, fromBeginning});
    return this;
  }

  subscribeBatched(option: BatchSubscribeOption): this {
    const {topic, ...rest} = option;
    this.consumeOptions.set(topic, {type: 'batch', ...rest});
    return this;
  }

  async start(): Promise<void> {
    if (this.startedPromise) {
      return this.startedPromise;
    }
    this.startedPromise = this.performStart();
    return this.startedPromise;
  }

  async stop(): Promise<void> {
    if (this.stoppedPromise) {
      return this.stoppedPromise;
    }
    this.stoppedPromise = new Promise((resolve, reject) => {
      this.workerController.synchronize(async () => {
        setImmediate(() => this.consumer.stop().then(resolve, reject));
        return true;
      });
    }).then(() => this.consumer.disconnect());
    return this.stoppedPromise;
  }

  private async performStart() {
    const topics = Array.from(this.consumeOptions.keys());
    const admin = this.client.admin();
    try {
      await this.consumer.connect();
      for (const [topic, option] of this.consumeOptions) {
        await this.consumer.subscribe({topic, fromBeginning: option.fromBeginning});
      }

      await admin.connect();
      const metadata = await admin.fetchTopicMetadata({topics});

      const totalPartitions = metadata.topics.reduce(
        (result, topicMetadata) => result + topicMetadata.partitions.length,
        0,
      );

      this.runPromise = this.consumer.run({
        autoCommit: true,
        autoCommitInterval: this.commitOption?.commitInterval,
        eachBatchAutoResolve: false,
        partitionsConsumedConcurrently: totalPartitions,
        eachBatch: async (payload) => this.eachBatch(payload),
      });
    } finally {
      await admin.disconnect();
    }
  }

  private async eachBatch(payload: EachBatchPayload) {
    const {topic, partition} = payload.batch;
    const consumeOption = this.consumeOptions.get(topic);
    if (!consumeOption) {
      throw new Error('Message received from unsubscribed topic');
    } else if (consumeOption.type === 'batch') {
      const {consumer} = consumeOption;
      return consumer(payload);
    }
    const {consumer} = consumeOption;
    const commitOffsets = async (forced: boolean = false) => {
      if (forced) {
        return payload.commitOffsetsIfNecessary(payload.uncommittedOffsets());
      } else {
        return payload.commitOffsetsIfNecessary();
      }
    };

    const heartbeat = async () => {
      try {
        await payload.heartbeat();
      } catch (e) {
        if (e.type === 'REBALANCE_IN_PROGRESS' || e.type === 'NOT_COORDINATOR_FOR_GROUP') {
          this.workerController.synchronize(async () => true);
        }
      }
    };

    await this.processBatch(
      async (message: KafkaJsMessage) => {
        await consumer({topic, partition, ...message});
        payload.resolveOffset(message.offset);
        await payload.commitOffsetsIfNecessary();
      },
      heartbeat,
      (offset: string) => payload.resolveOffset(offset),
      commitOffsets,
      payload.batch.messages,
    );
  }

  private async processBatch(
    consumer: (message: KafkaJsMessage) => Promise<void>,
    heartbeat: () => Promise<void>,
    resolveOffset: (offset: string) => void,
    commitOffset: (forced?: boolean) => Promise<void>,
    messages: KafkaJsMessage[],
  ) {
    const synchronizer = this.workerController.createSynchronizer(false);
    try {
      for (const message of messages) {
        await consumer(message);
        await heartbeat();
        resolveOffset(message.offset);
        if (await synchronizer.checkSynchronized(() => commitOffset(true))) {
          return;
        }
        await commitOffset();
      }
    } finally {
      synchronizer.detach();
    }
  }
}
