/**
 * The agent channel: hands a message to an agent hosted on this node.
 *
 * "Delivering" means putting the message on the agent's event feed, where the
 * agent picks it up through the local API (GET /api/v0/events). The agent then
 * marks it read and replies through the same API, so there is nothing to
 * ingest here.
 *
 * The inbox channel is the same handoff under another name, for a person: the
 * message stays on the node, and its owner reads and answers it on the node's
 * inbox page (or through the same API).
 */
import { AGENT_CHANNEL } from '../config.js';
import { textOf } from '../protocol/envelope.js';
import type { Envelope } from '../protocol/types.js';
import type { AdapterCapabilities, ChannelAdapter, DeliveryReceipt, RenderContext } from './types.js';

export interface AgentPayload {
  address: string;
  message_id: string;
  thread: string;
  data: Record<string, unknown>;
}

export class AgentAdapter implements ChannelAdapter<AgentPayload> {
  constructor(
    private readonly publish: (payload: AgentPayload) => Promise<number>,
    readonly name: string = AGENT_CHANNEL,
  ) {}

  capabilities(): AdapterCapabilities {
    return { read_receipts: true, replies: true, structured_data: 'native', files: 'native' };
  }

  render(message: Envelope, ctx: RenderContext): AgentPayload {
    return {
      address: ctx.recipient,
      message_id: message.id,
      thread: ctx.thread,
      data: {
        at: new Date().toISOString(),
        message: {
          id: message.id,
          thread: ctx.thread,
          from: message.from,
          on_behalf_of: ctx.principal,
          to: message.to,
          intent: message.intent,
          priority: message.priority ?? 'normal',
          created_at: message.created_at,
          expires_at: message.expires_at ?? null,
          requires_approval: message.requires_approval === true,
          sender_type: ctx.senderType,
          text: textOf(message.content),
          parts: message.content.parts,
        },
        // What this node checked before accepting the message.
        verified: ctx.verified,
      },
    };
  }

  async deliver(payload: AgentPayload): Promise<DeliveryReceipt> {
    const seq = await this.publish(payload);
    return { native_id: `event:${seq}` };
  }

  async ingest(): Promise<null> {
    return null;
  }
}
