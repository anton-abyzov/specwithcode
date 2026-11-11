// Server tests never send crash reports: a suite that builds the real server
// layer would otherwise post failed-turn reports to the production relay.
// CrashReporter tests read their env through a ConfigProvider, not this.
process.env.STUDIO_CRASH_REPORTS = "false";
