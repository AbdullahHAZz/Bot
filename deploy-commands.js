require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, ChannelType } = require("discord.js");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const dayChoices = [
  { name: "Mon", value: 1 },
  { name: "Tue", value: 2 },
  { name: "Wed", value: 3 },
  { name: "Thu", value: 4 },
  { name: "Fri", value: 5 },
  { name: "Sat", value: 6 },
  { name: "Sun", value: 7 },
];

const commands = [
  // ===== TYPE SETUP =====
  new SlashCommandBuilder()
    .setName("roster_type_setup")
    .setDescription("Setup a roster type (roster/announce/voice + mention role)")
    .addStringOption((o) => o.setName("type").setDescription("Type id (e.g. rb, event, informal)").setAutocomplete(true).setRequired(true))
    .addChannelOption((o) =>
      o
        .setName("roster_channel")
        .setDescription("Text channel where roster message will be posted")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName("announce_channel")
        .setDescription("Text channel where announcements will be posted")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName("voice_channel")
        .setDescription("Voice channel used for attendance (present/not present)")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    )
    .addRoleOption((o) =>
      o
        .setName("mention_role")
        .setDescription("Role to mention in announcements (optional)")
        .setRequired(false)
    )
    .addIntegerOption((o) =>
      o
        .setName("close_before_min")
        .setDescription("Default close-before minutes for this type (0-180). Used by wizard as default.")
        .setMinValue(0)
        .setMaxValue(180)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("roster_type_main_add")
    .setDescription("Add a Main Role (allowed to enter MAIN tier)")
    .addStringOption((o) => o.setName("type").setDescription("Type id").setAutocomplete(true).setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster_type_main_remove")
    .setDescription("Remove a Main Role from the type")
    .addStringOption((o) => o.setName("type").setDescription("Type id").setAutocomplete(true).setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster_type_sub_add")
    .setDescription("Add a Sub Role (allowed to enter SUB tier)")
    .addStringOption((o) => o.setName("type").setDescription("Type id").setAutocomplete(true).setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster_type_sub_remove")
    .setDescription("Remove a Sub Role from the type")
    .addStringOption((o) => o.setName("type").setDescription("Type id").setAutocomplete(true).setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster_type_require_role")
    .setDescription("Toggle require role to join (Main/Sub)")
    .addStringOption((o) => o.setName("type").setDescription("Type id").setAutocomplete(true).setRequired(true))
    .addBooleanOption((o) => o.setName("enabled").setDescription("true/false").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster_type_delete")
    .setDescription("Delete a roster type configuration")
    .addStringOption((o) => o.setName("type").setDescription("Type id").setAutocomplete(true).setRequired(true)),

  // ===== SCHEDULE (DAY/HOUR/MIN, UTC) =====
  new SlashCommandBuilder()
    .setName("roster_schedule")
    .setDescription("Schedule a roster (UTC) with Main/Sub/Waitlist + reminders")
    .addStringOption((o) => o.setName("type").setDescription("Type id").setAutocomplete(true).setRequired(true))
    .addStringOption((o) => o.setName("title").setDescription("Title").setRequired(true))

    // start
    .addIntegerOption((o) =>
      o.setName("start_day").setDescription("Start day").setRequired(true).addChoices(...dayChoices)
    )
    .addIntegerOption((o) =>
      o.setName("start_hour").setDescription("Start hour (0-23)").setRequired(true).setMinValue(0).setMaxValue(23)
    )
    .addIntegerOption((o) =>
      o.setName("start_minute").setDescription("Start minute (0-59)").setRequired(true).setMinValue(0).setMaxValue(59)
    )

    // end
    .addIntegerOption((o) =>
      o.setName("end_day").setDescription("End day").setRequired(true).addChoices(...dayChoices)
    )
    .addIntegerOption((o) =>
      o.setName("end_hour").setDescription("End hour (0-23)").setRequired(true).setMinValue(0).setMaxValue(23)
    )
    .addIntegerOption((o) =>
      o.setName("end_minute").setDescription("End minute (0-59)").setRequired(true).setMinValue(0).setMaxValue(59)
    )

    // limits
    .addIntegerOption((o) =>
      o.setName("main_limit").setDescription("MAIN limit (0-200)").setRequired(true).setMinValue(0).setMaxValue(200)
    )
    .addIntegerOption((o) =>
      o.setName("sub_limit").setDescription("SUB limit (0-200)").setRequired(true).setMinValue(0).setMaxValue(200)
    )

    // reminders
    .addStringOption((o) =>
      o
        .setName("reminders")
        .setDescription('Minutes before start, comma-separated (e.g. "20,10,0")')
        .setRequired(true)
    )

    // optional last
    .addStringOption((o) => o.setName("description").setDescription("Description (optional)").setRequired(false)),

  
// ===== WIZARD =====
new SlashCommandBuilder()
  .setName("roster_wizard")
  .setDescription("Roster Wizard: create/edit types and create rosters (UTC)")
  .addStringOption((o) => o.setName("type").setDescription("Type id (optional, quick create roster)").setAutocomplete(true).setRequired(false)),

// ===== ADMIN OPS =====
  new SlashCommandBuilder()
    .setName("roster_list")
    .setDescription("List latest rosters (optionally by type)")
    .addStringOption((o) => o.setName("type").setDescription("Type id (optional)").setAutocomplete(true).setRequired(false)),

  new SlashCommandBuilder()
    .setName("roster_delete")
    .setDescription("Delete a roster completely (scheduled/active)")
    .addStringOption((o) => o.setName("roster_id").setDescription("RosterId").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster_close")
    .setDescription("Close a roster by roster_id")
    .addStringOption((o) => o.setName("roster_id").setDescription("RosterId").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster_reset")
    .setDescription("Reset RSVPs for a roster")
    .addStringOption((o) => o.setName("roster_id").setDescription("RosterId").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster_kick")
    .setDescription("Remove a user from a roster")
    .addStringOption((o) => o.setName("roster_id").setDescription("RosterId").setRequired(true))
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
].map((c) => c.toJSON());

(async () => {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("Deploying commands...");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Commands deployed.");
  } catch (e) {
    console.error(e);
  }
})();