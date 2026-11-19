export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      activity: {
        Row: {
          at: string
          caller: string | null
          detail: Json | null
          id: number
          kind: string
          summary: string
        }
        Insert: {
          at?: string
          caller?: string | null
          detail?: Json | null
          id?: number
          kind: string
          summary: string
        }
        Update: {
          at?: string
          caller?: string | null
          detail?: Json | null
          id?: number
          kind?: string
          summary?: string
        }
        Relationships: []
      }
      callers: {
        Row: {
          call_count: number
          first_seen: string
          last_seen: string
          locked_until: string | null
          phone: string
          pin_failures: number
        }
        Insert: {
          call_count?: number
          first_seen?: string
          last_seen?: string
          locked_until?: string | null
          phone: string
          pin_failures?: number
        }
        Update: {
          call_count?: number
          first_seen?: string
          last_seen?: string
          locked_until?: string | null
          phone?: string
          pin_failures?: number
        }
        Relationships: []
      }
      intents: {
        Row: {
          caller: string
          code: string
          contract_expiry: string | null
          contract_label: string | null
          conversation_id: string | null
          created_at: string
          est_fee_usd: number
          event_ticker: string
          expires_at: string
          id: string
          instrument_symbol: string
          limit_price: number
          notional_usd: number
          outcome: string
          quantity: number
          quote_at: string | null
          quote_price: number | null
          side: string
          status: string
          time_in_force: string
          title: string | null
          updated_at: string
        }
        Insert: {
          caller: string
          code: string
          contract_expiry?: string | null
          contract_label?: string | null
          conversation_id?: string | null
          created_at?: string
          est_fee_usd: number
          event_ticker: string
          expires_at: string
          id?: string
          instrument_symbol: string
          limit_price: number
          notional_usd: number
          outcome: string
          quantity: number
          quote_at?: string | null
          quote_price?: number | null
          side: string
          status?: string
          time_in_force?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          caller?: string
          code?: string
          contract_expiry?: string | null
          contract_label?: string | null
          conversation_id?: string | null
          created_at?: string
          est_fee_usd?: number
          event_ticker?: string
          expires_at?: string
          id?: string
          instrument_symbol?: string
          limit_price?: number
          notional_usd?: number
          outcome?: string
          quantity?: number
          quote_at?: string | null
          quote_price?: number | null
          side?: string
          status?: string
          time_in_force?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          avg_price: number | null
          created_at: string
          error: string | null
          exchange_status: string | null
          filled_notional_usd: number
          filled_qty: number | null
          gemini_order_id: string | null
          id: string
          intent_id: string
          outcome_summary: string
          raw: Json | null
          remaining_qty: number | null
          side: string
        }
        Insert: {
          avg_price?: number | null
          created_at?: string
          error?: string | null
          exchange_status?: string | null
          filled_notional_usd?: number
          filled_qty?: number | null
          gemini_order_id?: string | null
          id?: string
          intent_id: string
          outcome_summary: string
          raw?: Json | null
          remaining_qty?: number | null
          side: string
        }
        Update: {
          avg_price?: number | null
          created_at?: string
          error?: string | null
          exchange_status?: string | null
          filled_notional_usd?: number
          filled_qty?: number | null
          gemini_order_id?: string | null
          id?: string
          intent_id?: string
          outcome_summary?: string
          raw?: Json | null
          remaining_qty?: number | null
          side?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: true
            referencedRelation: "intents"
            referencedColumns: ["id"]
          },
        ]
      }
      receipts: {
        Row: {
          created_at: string
          error: string | null
          id: string
          intent_id: string | null
          kind: string
          payload_text: string
          sha256: string
          solana_sig: string | null
        }
        Insert: {
          created_at?: string
          error?: string | null
          id?: string
          intent_id?: string | null
          kind: string
          payload_text: string
          sha256: string
          solana_sig?: string | null
        }
        Update: {
          created_at?: string
          error?: string | null
          id?: string
          intent_id?: string | null
          kind?: string
          payload_text?: string
          sha256?: string
          solana_sig?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "receipts_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "intents"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          key: string
          value: Json
        }
        Insert: {
          key: string
          value: Json
        }
        Update: {
          key?: string
          value?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
