import {Consumer, ConsumerConfig, EachBatchPayload, Kafka, KafkaMessage} from 'kafkajs';
import Long from 'long';
import {WorkerController} from './worker-synchronizer';
import {convertConnectOption, createLogOption, KafkaLogOption} from './utils';
import {KafkaConnectOption} from './types';

export type KafkaFetchOption = ConsumerConfig;

export interface KafkaCommitOption {
  commitInterval: number;
}

export interface MessageConsumerOption {
  connectOption: KafkaConnectOption;
  fetchOption: KafkaFetchOption;
  commitOption?: KafkaCommitOption;
  logOption?: KafkaLogOption;
}

export interface MessageMetadata extends Omit<KafkaMessage, 'value'> {
  topic: string;
  partition: number;
  offset: string;
  consumerGroupId: string;
}

export interface MessageConsumeCallback {
  (message: Buffer, metadata: MessageMetadata): Promise<void>;
}

interface ConsumeOption {
  consumer: MessageConsumeCallback;
  fromBeginning: boolean;
}

export class MessageConsumer {
  private client: Kafka;
  private consumer: Consumer;
  private consumeOptions: Map<string, ConsumeOption> = new Map();
  private runPromise?: Promise<unknown>;
  private workerController = new WorkerController<boolean>();
  private startedPromise?: Promise<void>;
  private stoppedPromise?: Promise<void>;

  constructor(private option: MessageConsumerOption) {
    this.client = new Kafka(convertConnectOption(option.connectOption, option.logOption));
    this.consumer = this.client.consumer(option.fetchOption);
  }

  subscribe(topic: string, consumer: MessageConsumeCallback, fromBeginning: boolean = false): this {
    this.consumeOptions.set(topic, {consumer, fromBeginning});
    return this;
  }

  async start() {
    if (this.startedPromise) {
      return this.startedPromise;
    }
    this.startedPromise = this.performStart();
    return this.startedPromise;
  }

  async stop() {
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
      await admin.connect();
      const metadata = await admin.fetchTopicMetadata({topics});

      const totalPartitions = metadata.topics
        .reduce((result, topicMetadata) => result + topicMetadata.partitions.length, 0);

      await this.consumer.connect();
      for (const [topic, option] of this.consumeOptions) {
        await this.consumer.subscribe({topic, fromBeginning: option.fromBeginning});
      }

      this.runPromise = this.consumer.run({
        autoCommit: true,
        autoCommitInterval: this.option.commitOption?.commitInterval,
        eachBatchAutoResolve: false,
        partitionsConsumedConcurrently: totalPartitions,
        eachBatch: this.eachBatch.bind(this),
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
    }
    const forceCommitOffset = (offset: string) => {
      offset = Long.fromValue(offset).add(1).toString();
      return payload.commitOffsetsIfNecessary({
        topics: [{topic, partitions: [{partition, offset}]}],
      });
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
      async (message: KafkaMessage) => {
        const {value, ...metadata} = message;
        await consumeOption.consumer(
          value,
          {topic, partition, consumerGroupId: this.option.fetchOption.groupId, ...metadata},
        );
        await payload.resolveOffset(message.offset);
      },
      heartbeat,
      forceCommitOffset,
      payload.batch.messages,
    );
  }

  private async processBatch(
    consumer: (message: KafkaMessage) => Promise<void>,
    heartbeat: () => Promise<void>,
    commitOffset: (offset: string) => Promise<void>,
    messages: KafkaMessage[],
  ) {
    const synchronizer = this.workerController.createSynchronizer(false);
    try {
      for (const message of messages) {
        await consumer(message);
        await heartbeat();
        if (await synchronizer.checkSynchronized(() => commitOffset(message.offset))) {
          return;
        }
      }
    } finally {
      synchronizer.detach();
    }
  }
}
