import Testing
import SWCWire

@Suite struct ProjectOriginTests {
  @Test func demoFoldersAreAutomatedLikeTheWeb() {
    // Sample apps an agent registered to record a demo (October 30, 2026).
    #expect(ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/experiments/greet-app-demo"))
    #expect(ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/experiments/swc-demo-greet-fleet"))
    // Only whole words count, and the app's projects folder is always the person's.
    #expect(!ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/demographics"))
    #expect(!ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/demo/invoices"))
    #expect(!ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/.specwithcode/m4/projects/demo-notes"))
    #expect(!ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/sw-easychamp"))
  }
}
