import { create } from 'zustand';
import type { AIChatResponse, ActionResult, Card } from '@orbis/shared';
import { trpcClient } from '../lib/trpc.ts';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  actions?: ActionResult[];
  cards?: Card[];
  suggestions?: string[];
  timestamp: number;
}

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  sendMessage: (text: string, context?: { activeView?: string }) => Promise<void>;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isLoading: false,

  sendMessage: async (text, context) => {
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      timestamp: Date.now(),
    };

    set((s) => ({ messages: [...s.messages, userMessage], isLoading: true }));

    try {
      const result: AIChatResponse = await trpcClient.ai.chat.mutate({
        message: text,
        context,
      });

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: result.response,
        actions: result.actions,
        cards: result.cards,
        suggestions: result.suggestions,
        timestamp: Date.now(),
      };

      set((s) => ({ messages: [...s.messages, assistantMessage], isLoading: false }));
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: error instanceof Error ? error.message : 'Something went wrong. Please try again.',
        timestamp: Date.now(),
      };

      set((s) => ({ messages: [...s.messages, errorMessage], isLoading: false }));
    }
  },

  clearMessages: () => set({ messages: [] }),
}));
