import Foundation

// Effective German dictionary: the web base overlaid with the mobile tables (they share no key; mobile/tools/loc-audit.sh checks that).
let LocDE: [String: String] = LocDEBase
    .merging(LocDEMobile) { _, mobile in mobile }
    .merging(LocDECommunication) { _, communication in communication }
    .merging(LocDEOuterLoop) { _, outerLoop in outerLoop }
    .merging(LocDEProjects) { _, projects in projects }
    // Preview links
    .merging(LocDEPreview) { _, preview in preview }
    // Instances tab
    .merging(LocDEInstances) { _, instances in instances }
    // Skills
    .merging(LocDESkills) { _, skills in skills }
    // Settings → Chats and auto-archive
    .merging(LocDEChats) { _, chats in chats }
    // Agenda per coding chat
    .merging(LocDEAgenda) { _, agenda in agenda }
    // Administration
    .merging(LocDEAdministration) { _, administration in administration }
    // Providers and usage
    .merging(LocDEUsage) { _, usage in usage }
    // Coding MCP airlock
    .merging(LocDEMcp) { _, mcp in mcp }
    // Coding → Scheduled
    .merging(LocDEScheduled) { _, scheduled in scheduled }
    // Git overview
    .merging(LocDEGit) { _, git in git }
    // Project timeline
    .merging(LocDETimeline) { _, timeline in timeline }
