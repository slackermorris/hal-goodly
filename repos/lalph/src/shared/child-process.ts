export const parseCommand = (command: string): ReadonlyArray<string> => {
  const args: string[] = []
  let currentArg = ""
  let inQuotes = false
  let escapeNext = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (escapeNext) {
      currentArg += char
      escapeNext = false
    } else if (char === "\\") {
      escapeNext = true
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === " " && !inQuotes) {
      if (currentArg.length > 0) {
        args.push(currentArg)
        currentArg = ""
      }
    } else {
      currentArg += char
    }
  }

  if (currentArg.length > 0) {
    args.push(currentArg)
  }

  return args
}
