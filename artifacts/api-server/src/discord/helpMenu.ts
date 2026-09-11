import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

export type HelpCategory = "overview" | "amongus" | "voice" | "counter" | "utility";

export function getHelpEmbed(category: HelpCategory = "overview"): EmbedBuilder {
  const embed = new EmbedBuilder();

  switch (category) {
    case "amongus":
    case "voice":
      return embed
        .setColor(0x57f287)
        .setTitle("Among Us & Voice Channel Controls")
        .setDescription(
          "Coordinate discussion rounds and gameplay seamlessly in voice channels.\nBoth `/slash` and `.prefix` commands are fully supported.\n"
        )
        .addFields(
          {
            name: "Voice Channel Controls",
            value: [
              "> `/join` • `.join` — Joins your current voice channel (deafened).",
              "> `/leave` • `.leave` — Disconnects from voice and resets bot status.",
              "> `/status` • `.status` — Lists active members in VC and their mute state.",
              "> `/mute` • `.mute` — Server-mutes everyone in VC for discussions.",
              "> `/unmute` • `.unmute` — Unmutes everyone in VC for gameplay.",
            ].join("\n"),
          },
          {
            name: "Dead Player Tracking",
            value: [
              "> `/dead <@player>` • `.dead <@player>`",
              "> *Marks player dead & keeps them server-muted in the main VC.*",
              "> `/undead [@player]` • `.undead [@player]`",
              "> *Clears dead list (or unmarks one player) for a new round.*",
              "> `/list` • `.list`",
              "> *Displays all currently dead players.*",
            ].join("\n"),
          },
          {
            name: "Lobby Codes",
            value:
              "> `/code [code]` • `.code [code]`\n> *Saves or recalls the 6-letter lobby code. Standalone uppercase 6-letter codes are automatically detected.*",
          },
        )
        .setFooter({ text: "Voice commands apply to your current voice channel • Dea Bot" });

    case "counter":
      return embed
        .setColor(0xfee75c)
        .setTitle("Automated Slur Counter System")
        .setDescription(
          "Real-time automated detection and tracking with persistent per-server statistics.\n"
        )
        .addFields(
          {
            name: "User Counts & Leaderboards",
            value: [
              "> `/nwordcount [@user]` • `.ncount` • `.nwordcount`",
              "> *Checks slur count for yourself or another user.*",
              "> `/nwordleaderboard` • `.nlb` • `.nleaderboard`",
              "> *Displays the top 10 users in this server.*",
            ].join("\n"),
          },
          {
            name: "Server Configuration (Manage Server)",
            value: [
              "> `/nwordcounter enable` • `.ncounter enable` — Turns counter ON.",
              "> `/nwordcounter disable` • `.ncounter disable` — Turns counter OFF.",
              "> `/nwordcounter status` • `.ncounter` — Checks counter status.",
            ].join("\n"),
          },
          {
            name: "Automatic Detection",
            value:
              "> • Automatically detects slur variations and increments persistent records.\n> • Filters out bots, webhook messages, and duplicates.\n> • Replies with a dynamic reaction message.",
          },
        )
        .setFooter({ text: "Persistent per-server data • Dea Counter" });

    case "utility":
      return embed
        .setColor(0xeb459e)
        .setTitle("Utility & System Information")
        .setDescription("General bot utility, status commands, and helpful tips.\n")
        .addFields(
          {
            name: "Bot Information",
            value: [
              "> `/uptime` • `.uptime` — Shows how long Dea has been running.",
              "> `/help` • `.help` — Displays this interactive command dashboard.",
            ].join("\n"),
          },
          {
            name: "Quick Tips",
            value: [
              "> • You can use either `/slash` commands or `.` prefix commands anytime.",
              "> • When in a voice channel, the bot status shows your channel name.",
              "> • When leaving via `.leave`, status resets to Waiting for a voice channel.",
              "> • Click the buttons below to browse categories.",
            ].join("\n"),
          },
        )
        .setFooter({ text: "Dea • Multi-purpose Discord Bot" });

    case "overview":
    default:
      return embed
        .setColor(0x5865f2)
        .setTitle("Dea Command Center & Guide")
        .setDescription(
          "Welcome to **Dea**! Here is an organized guide to all features.\nClick the buttons below to browse each category.\n"
        )
        .addFields(
          {
            name: "Among Us & Voice Controls",
            value: "> Automatic VC joining, discussion mute/unmute rounds, dead-player tracking, and lobby codes.",
          },
          {
            name: "Automated Slur Counter",
            value: "> Real-time slur detection, persistent per-server counts, leaderboards, and admin settings.",
          },
          {
            name: "Utility & System",
            value: "> Bot uptime, status diagnostics, and interactive guides.",
          },
          {
            name: "Syntax Conventions",
            value: "> `<required argument>` • `[optional argument]` • `/slash` or `.prefix`",
          },
        )
        .setFooter({ text: "Click any button below to switch views • Dea Bot" });
  }
}

export function getHelpButtons(currentCategory: HelpCategory = "overview"): ActionRowBuilder<ButtonBuilder> {
  const isAmongUs = currentCategory === "amongus" || currentCategory === "voice";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("help_overview")
      .setLabel("Overview")
      .setStyle(currentCategory === "overview" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("help_amongus")
      .setLabel("Among Us")
      .setStyle(isAmongUs ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("help_counter")
      .setLabel("Counter")
      .setStyle(currentCategory === "counter" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("help_utility")
      .setLabel("Utility")
      .setStyle(currentCategory === "utility" ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
}
