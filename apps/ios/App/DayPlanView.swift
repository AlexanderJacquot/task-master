import SwiftUI
import TaskMasterKit

/// One day's time blocks, as a plain list: step between days, nudge a block, record how
/// it went, or take it off the plan. The timeline with drag and resize comes with design.
struct DayPlanView: View {
    @State private var plan: DayPlanModel

    init(session: Session) {
        _plan = State(initialValue: DayPlanModel(session: session))
    }

    var body: some View {
        List {
            Section {
                HStack {
                    Button("Previous day", systemImage: "chevron.left") { plan.step(-1) }
                    Spacer()
                    Text(plan.date).font(.headline)
                    Spacer()
                    Button("Next day", systemImage: "chevron.right") { plan.step(1) }
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
            }
            Section {
                ForEach(plan.blocks) { block in
                    NavigationLink(value: Route.task(id: block.taskId)) {
                        VStack(alignment: .leading) {
                            Text(block.title)
                            Text("\(clockTime(block.startAt)) – \(clockTime(block.endAt)) · \(String(describing: block.outcome))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .contextMenu {
                        Button("15 min later") { shift(block, by: 15) }
                        Button("15 min earlier") { shift(block, by: -15) }
                        Button("15 min longer") { extend(block, by: 15) }
                        Divider()
                        Button("Done") { plan.setOutcome(block, .done) }
                        Button("Worked on it") { plan.setOutcome(block, .worked) }
                        Button("Missed") { plan.setOutcome(block, .missed) }
                        Button("Planned") { plan.setOutcome(block, .planned) }
                    }
                    .swipeActions {
                        Button("Unplan", role: .destructive) { plan.unschedule(block) }
                    }
                }
            } footer: {
                if plan.blocks.isEmpty {
                    Text("Nothing planned. Plan time from a task's page.")
                }
            }
            if let error = plan.error {
                Text(error).foregroundStyle(.red)
            }
        }
        .navigationTitle("Day plan")
    }

    private func shift(_ block: BlockItem, by minutes: Int64) {
        let delta = Double(minutes * 60)
        plan.move(
            block, start: Session.date(block.startAt).addingTimeInterval(delta),
            end: Session.date(block.endAt).addingTimeInterval(delta))
    }

    private func extend(_ block: BlockItem, by minutes: Int64) {
        plan.move(
            block, start: Session.date(block.startAt),
            end: Session.date(block.endAt).addingTimeInterval(Double(minutes * 60)))
    }
}
