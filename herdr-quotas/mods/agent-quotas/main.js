// Agent Quotas mod for Herdr
// Dual-mode: Compact Sidebar Widget or Detailed Popup Dialog.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme, props, closeOverlay, openOverlay, run,
  setShared, shared, notify
} from "herdr";
import { collectAllQuotas, formatTimeRemaining } from "./collector.js";

const OVERLAY_KEY = "agent-quotas.open-overlay";

function getBarColor(t, percent) {
  if (percent >= 90) return t.ansi1; // red / warning
  if (percent >= 70) return t.blocked || "#e3814f"; // yellow / orange
  return t.ansi2; // green / normal
}

export default class AgentQuotas extends View {
  init(initialProps, cx) {
    const p = initialProps ?? props() ?? {};
    this.overlayId = p.overlay ?? null;
    this.role = p.role ?? (this.overlayId ? "dialog" : "dialog");
    this.data = null;
    this.loading = true;
    this.error = null;

    this.handle = cx.focus_handle();
    if (this.role === "dialog") {
      this.handle.focus();
    }

    this.refresh(cx);

    // Auto refresh every 20 seconds
    cx.timer.every(20000, (cx) => {
      this.refresh(cx);
    });
  }

  refresh(cx) {
    this.loading = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const result = await collectAllQuotas();
        this.data = result;
        this.error = null;
      } catch (err) {
        this.error = String(err);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  openDetailedDialog() {
    if (this.overlayId) return;
    const existing = shared(OVERLAY_KEY);
    if (existing) {
      closeOverlay(existing);
    }
    const id = openOverlay({
      mod: "agent-quotas",
      props: { role: "dialog" },
    });
    setShared(OVERLAY_KEY, id);
  }

  close() {
    if (this.overlayId) {
      closeOverlay(this.overlayId);
      setShared(OVERLAY_KEY, null);
    }
  }

  // --- Render Compact Widget (Sidebar) ---
  renderWidget(t, cx) {
    const claude = this.data?.claude;
    const codex = this.data?.codex;
    const agy = this.data?.antigravity;

    const claudePercent = claude?.primaryPercent ?? 0;
    const claudeColor = getBarColor(t, claudePercent);

    return v_flex()
      .id("agent-quotas-widget")
      .size_full()
      .p(10)
      .gap(6)
      .rounded(8)
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .cursor_pointer()
      .hover((s) => s.bg(t.raised))
      .on_click(() => this.openDetailedDialog())
      // Widget Header
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(div().text_size(12).child("📊"))
              .child(div().font_semibold().text_size(11.5).text_color(t.foreground).child("Agent Quotas"))
          )
          .child(
            div()
              .text_size(10.5)
              .text_color(t.dim)
              .child(this.loading ? "Updating…" : "Details ↗")
          )
      )
      // Row 1: Claude Code
      .child(
        v_flex()
          .gap(2)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(4)
                  .items_center()
                  .child(div().w(6).h(6).rounded(3).bg("#da7756")) // Claude coral
                  .child(div().text_size(11).text_color(t.foreground).child("Claude"))
              )
              .child(
                div()
                  .text_size(10.5)
                  .font_medium()
                  .text_color(claudeColor)
                  .child(claude?.available ? `${claudePercent}%` : "Offline")
              )
          )
          // Progress bar track
          .child(
            h_flex()
              .h(4)
              .w_full()
              .rounded(2)
              .bg(t.background)
              .overflow_hidden()
              .child(
                div()
                  .h_full()
                  .w(`${Math.max(2, Math.min(100, claudePercent))}%`)
                  .bg(claudeColor)
                  .rounded(2)
              )
          )
      )
      // Row 2: Codex
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(div().w(6).h(6).rounded(3).bg("#10a37f")) // OpenAI green
              .child(div().text_size(11).text_color(t.foreground).child(`Codex (${codex?.plan || "Pro"})`))
          )
          .child(
            div()
              .text_size(10.5)
              .text_color(t.muted)
              .child(codex?.formattedTokens ? `${codex.formattedTokens} tok` : "-")
          )
      )
      // Row 3: Antigravity
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(div().w(6).h(6).rounded(3).bg("#4285f4")) // Google blue
              .child(div().text_size(11).text_color(t.foreground).child("Antigravity"))
          )
          .child(
            div()
              .text_size(10.5)
              .text_color(t.muted)
              .child(agy?.stepsToday ? `${agy.stepsToday} steps` : "Ready")
          )
      );
  }

  // --- Render Full Dialog (Popup / Overlay) ---
  renderDialog(t, cx) {
    const claude = this.data?.claude;
    const codex = this.data?.codex;
    const agy = this.data?.antigravity;

    const sevenDayPercent = claude?.sevenDay?.percent ?? 0;
    const sevenDayColor = getBarColor(t, sevenDayPercent);

    return v_flex()
      .id("agent-quotas-dialog")
      .track_focus(this.handle)
      .size_full()
      .bg(t.popover)
      .rounded(12)
      .border_1()
      .border_color(t.border)
      .overflow_hidden()
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.overlayId) {
          this.close();
          cx.stop_propagation();
        }
      })
      // Header
      .child(
        h_flex()
          .h(46)
          .flex_none()
          .px(16)
          .gap(8)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(div().text_size(16).child("📊"))
          .child(
            div()
              .font_semibold()
              .text_size(14)
              .text_color(t.foreground)
              .child("Coding Agent Quotas & Usage")
          )
          .child(div().flex_1())
          // Refresh Button
          .child(
            h_flex()
              .px(8)
              .h(26)
              .rounded(5)
              .items_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.refresh(cx))
              .child(div().text_size(12).text_color(t.muted).child(this.loading ? "Refreshing…" : "↻ Refresh"))
          )
          // Close Button
          .child(
            h_flex()
              .w(26)
              .h(26)
              .rounded(5)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => this.close())
              .child(div().text_size(14).text_color(t.muted).child("✕"))
          )
      )
      // Cards Container
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(16)
          .gap(14)
          // --- Card 1: Claude Code ---
          .child(
            v_flex()
              .p(14)
              .gap(10)
              .rounded(10)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              // Header line
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(8)
                      .items_center()
                      .child(div().w(10).h(10).rounded(5).bg("#da7756"))
                      .child(div().font_semibold().text_size(14).text_color(t.foreground).child("Claude Code"))
                      .child(
                        div()
                          .px(6)
                          .py(1)
                          .rounded(4)
                          .bg(t.raised)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(claude?.tier || "Official")
                      )
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(claude?.org ? `Org: ${claude.org}` : "")
                  )
              )
              // 7-Day Limit Bar
              .child(
                v_flex()
                  .gap(4)
                  .child(
                    h_flex()
                      .items_center()
                      .justify_between()
                      .child(div().text_size(12).text_color(t.muted).child("7-Day Usage Limit"))
                      .child(
                        h_flex()
                          .gap(6)
                          .items_center()
                          .child(div().text_size(12).font_semibold().text_color(sevenDayColor).child(`${sevenDayPercent}%`))
                          .when(Boolean(claude?.sevenDay?.timeRemaining), (tEl) =>
                            tEl.child(
                              div()
                                .px(5)
                                .py(1)
                                .rounded(4)
                                .bg(t.background)
                                .text_size(10.5)
                                .text_color(t.dim)
                                .child(`Resets ${claude.sevenDay.timeRemaining}`)
                            )
                          )
                      )
                  )
                  .child(
                    h_flex()
                      .h(6)
                      .w_full()
                      .rounded(3)
                      .bg(t.background)
                      .overflow_hidden()
                      .child(
                        div()
                          .h_full()
                          .w(`${Math.max(1, Math.min(100, sevenDayPercent))}%`)
                          .bg(sevenDayColor)
                          .rounded(3)
                      )
                  )
              )
              // Extra Usage line (if enabled)
              .when(Boolean(claude?.extraUsage?.enabled), (eEl) =>
                eEl.child(
                  h_flex()
                    .p(8)
                    .rounded(6)
                    .bg(t.background)
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .gap(6)
                        .items_center()
                        .child(div().text_size(11.5).text_color(t.muted).child("Extra Monthly Spend:"))
                        .child(
                          div()
                            .text_size(12)
                            .font_medium()
                            .text_color(t.foreground)
                            .child(`$${claude.extraUsage.used} / $${claude.extraUsage.limit}`)
                        )
                    )
                    .child(
                      div()
                        .text_size(11.5)
                        .font_medium()
                        .text_color(claude.extraUsage.percent >= 80 ? t.ansi1 : t.accent)
                        .child(`${claude.extraUsage.percent}% used`)
                    )
                )
              )
          )
          // --- Card 2: Codex ---
          .child(
            v_flex()
              .p(14)
              .gap(10)
              .rounded(10)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(8)
                      .items_center()
                      .child(div().w(10).h(10).rounded(5).bg("#10a37f"))
                      .child(div().font_semibold().text_size(14).text_color(t.foreground).child("Codex"))
                      .child(
                        div()
                          .px(6)
                          .py(1)
                          .rounded(4)
                          .bg(t.raised)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(codex?.plan || "PROLITE")
                      )
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(`Model: ${codex?.model || "GPT-5"}`)
                  )
              )
              // Metrics line
              .child(
                h_flex()
                  .gap(10)
                  .child(
                    v_flex()
                      .flex_1()
                      .p(8)
                      .rounded(6)
                      .bg(t.background)
                      .gap(2)
                      .child(div().text_size(11).text_color(t.dim).child("Today's Token Volume"))
                      .child(div().text_size(16).font_semibold().text_color(t.foreground).child(codex?.formattedTokens || "0"))
                  )
                  .child(
                    v_flex()
                      .flex_1()
                      .p(8)
                      .rounded(6)
                      .bg(t.background)
                      .gap(2)
                      .child(div().text_size(11).text_color(t.dim).child("Today's Active Turns"))
                      .child(div().text_size(16).font_semibold().text_color(t.foreground).child(String(codex?.turnsToday || 0)))
                  )
              )
          )
          // --- Card 3: Antigravity ---
          .child(
            v_flex()
              .p(14)
              .gap(10)
              .rounded(10)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(8)
                      .items_center()
                      .child(div().w(10).h(10).rounded(5).bg("#4285f4"))
                      .child(div().font_semibold().text_size(14).text_color(t.foreground).child("Antigravity"))
                      .child(
                        div()
                          .px(6)
                          .py(1)
                          .rounded(4)
                          .bg(t.raised)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(agy?.status || "Live")
                      )
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(agy?.model || "Gemini 3.8 Flash")
                  )
              )
              // Metrics line
              .child(
                h_flex()
                  .gap(10)
                  .child(
                    v_flex()
                      .flex_1()
                      .p(8)
                      .rounded(6)
                      .bg(t.background)
                      .gap(2)
                      .child(div().text_size(11).text_color(t.dim).child("Today's Execution Steps"))
                      .child(div().text_size(16).font_semibold().text_color(t.foreground).child(String(agy?.stepsToday || 0)))
                  )
                  .child(
                    v_flex()
                      .flex_1()
                      .p(8)
                      .rounded(6)
                      .bg(t.background)
                      .gap(2)
                      .child(div().text_size(11).text_color(t.dim).child("Today's Conversations"))
                      .child(div().text_size(16).font_semibold().text_color(t.foreground).child(String(agy?.conversationsToday || 0)))
                  )
              )
          )
      )
      // Footer hint
      .child(
        h_flex()
          .h(30)
          .flex_none()
          .px(16)
          .items_center()
          .justify_between()
          .bg(t.surface)
          .border_t(1)
          .border_color(t.border)
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(this.data?.updatedAt ? `Last refreshed: ${new Date(this.data.updatedAt).toLocaleTimeString()}` : "")
          )
          .child(div().text_size(11).text_color(t.dim).child("Press Esc to close"))
      );
  }

  render(cx) {
    const t = theme();
    if (this.role === "widget") {
      return this.renderWidget(t, cx);
    }
    return this.renderDialog(t, cx);
  }
}
