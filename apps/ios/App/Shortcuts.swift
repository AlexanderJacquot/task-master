import AppIntents

/// The phrases Siri and Spotlight offer without setup. Each includes the app's name, or
/// the system drops it.
struct TaskMasterShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddTaskIntent(),
            phrases: ["Add a task in \(.applicationName)", "New \(.applicationName) task"],
            shortTitle: "Add Task", systemImageName: "plus.circle")
        AppShortcut(
            intent: ShowTodayIntent(),
            phrases: ["Show today in \(.applicationName)", "What's on today in \(.applicationName)"],
            shortTitle: "Today", systemImageName: "sun.max")
        AppShortcut(
            intent: CompleteTaskIntent(),
            phrases: ["Complete a task in \(.applicationName)"],
            shortTitle: "Complete Task", systemImageName: "checkmark.circle")
    }
}
