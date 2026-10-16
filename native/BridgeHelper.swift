import Foundation
import Darwin
import CryptoKit

enum BridgeError: Error { case denied(String) }
let limit = 1_048_576
func fail(_ message: String) throws -> Never { throw BridgeError.denied(message) }
func check(_ result: Int32) throws -> Int32 {
    guard result >= 0 else { try fail("Filesystem operation denied (\(errno))") }
    return result
}
func components(_ input: String, allowRoot: Bool = false) throws -> [String] {
    if input.isEmpty && allowRoot { return [] }
    guard !input.isEmpty, !input.hasPrefix("/"), input.utf8.count <= 2048, !input.contains("\0") else { try fail("Invalid relative path") }
    let parts = input.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count <= 32, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255 }) else { try fail("Invalid relative path") }
    return parts
}
func directory(_ root: Int32, _ parts: [String]) throws -> Int32 {
    // A duplicated descriptor shares readdir's offset with the retained root.
    var fd = try check(openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
    do {
        for part in parts {
            let next = try check(openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
            close(fd); fd = next
        }
        return fd
    } catch { close(fd); throw error }
}
func regular(_ parent: Int32, _ name: String) throws -> (Int32, stat) {
    let fd = try check(openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
    var info = stat()
    do {
        _ = try check(fstat(fd, &info))
        guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_size <= limit else { try fail("Only bounded regular files without hard links are allowed") }
        return (fd, info)
    } catch { close(fd); throw error }
}
func readBytes(_ fd: Int32) throws -> Data {
    var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
    while true {
        let count = read(fd, &buffer, buffer.count)
        guard count >= 0 else { try fail("File read failed") }
        if count == 0 { return data }
        guard data.count + count <= limit else { try fail("File exceeds transfer limit") }
        data.append(contentsOf: buffer.prefix(count))
    }
}
let commandIds: Set<String> = ["git-status", "git-diff", "git-log"]
func inspectCommandTree(_ root: Int32, _ count: inout Int, _ depth: Int = 0) throws {
    guard depth <= 32 else { try fail("Command directory is too deep") }
    let duplicate = try check(openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
    guard let stream = fdopendir(duplicate) else { close(duplicate); try fail("Cannot inspect command directory") }
    defer { closedir(stream) }
    while let entry = readdir(stream) {
        let name = withUnsafePointer(to: &entry.pointee.d_name) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
        }
        if name == "." || name == ".." { continue }
        count += 1
        guard count <= 20_000 else { try fail("Command directory exceeds inspection limit") }
        var info = stat()
        _ = try check(fstatat(root, name, &info, AT_SYMLINK_NOFOLLOW))
        if info.st_mode & S_IFMT == S_IFREG && info.st_nlink != 1 { try fail("Hard-linked command files are not allowed") }
        if info.st_mode & S_IFMT == S_IFDIR {
            let fd = try directory(root, [name])
            defer { close(fd) }
            try inspectCommandTree(fd, &count, depth + 1)
        }
    }
}
func runCommand(_ root: Int32, _ approved: Set<String>, _ input: [String: Any]) throws -> Any {
    guard Set(input.keys) == Set(["id", "operation", "command"]),
          let command = input["command"] as? String, approved.contains(command), commandIds.contains(command) else { try fail("Command capability is not granted") }
    let repository = try directory(root, [".git"])
    close(repository)
    var count = 0
    try inspectCommandTree(root, &count)
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    _ = try check(fcntl(root, F_GETPATH, &buffer))
    let location = String(cString: buffer)
    guard !location.contains("\n"), !location.contains("\r") else { try fail("Invalid command directory") }
    _ = try check(fchdir(root))
    let git = "/Library/Developer/CommandLineTools/usr/bin/git"
    var binary = stat()
    _ = try check(lstat(git, &binary))
    guard binary.st_mode & S_IFMT == S_IFREG, binary.st_uid == 0, binary.st_mode & 0o022 == 0 else { try fail("Trusted system Git is unavailable") }
    let profile = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("host-command.sb").path
    guard FileManager.default.isReadableFile(atPath: profile) else { try fail("Command sandbox profile is unavailable") }
    let arguments: [String]
    switch command {
    case "git-status": arguments = ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all"]
    case "git-diff": arguments = ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-color", "--"]
    case "git-log": arguments = ["log", "-20", "--format=%h %s", "--no-decorate", "--no-show-signature", "--"]
    default: try fail("Command capability is not granted")
    }
    let launch = ["/usr/bin/sandbox-exec", "-D", "ROOT=" + location, "-D", "PROGRAM=" + git, "-f", profile, git,
        "--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
        "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null"] + arguments
    let environment = ["PATH": "/usr/bin:/bin", "HOME": "/var/empty", "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_ATTR_NOSYSTEM": "1", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0",
        "GIT_CEILING_DIRECTORIES": URL(fileURLWithPath: location).deletingLastPathComponent().path]
    var descriptors = [Int32](repeating: -1, count: 2)
    _ = try check(pipe(&descriptors))
    defer { close(descriptors[0]) }
    let null = try check(open("/dev/null", O_RDONLY | O_CLOEXEC))
    defer { close(null) }
    var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
    guard posix_spawn_file_actions_init(&actions) == 0, posix_spawnattr_init(&attributes) == 0 else { close(descriptors[1]); try fail("Cannot prepare command") }
    defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
    posix_spawn_file_actions_adddup2(&actions, null, STDIN_FILENO)
    posix_spawn_file_actions_adddup2(&actions, descriptors[1], STDOUT_FILENO)
    posix_spawn_file_actions_adddup2(&actions, descriptors[1], STDERR_FILENO)
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
    posix_spawnattr_setpgroup(&attributes, getpgrp())
    let argv = launch.map { strdup($0) } + [nil]
    let envp = environment.map { strdup($0.key + "=" + $0.value) } + [nil]
    defer { for value in argv + envp { free(value) } }
    var pid: pid_t = 0
    let launched = posix_spawn(&pid, launch[0], &actions, &attributes, argv, envp)
    close(descriptors[1])
    guard launched == 0 else { try fail("Command sandbox could not start (\(launched))") }
    var data = Data()
    var status: Int32 = 0
    var chunk = [UInt8](repeating: 0, count: 8192)
    do {
        while true {
            let received = read(descriptors[0], &chunk, chunk.count)
            if received < 0 && errno == EINTR { continue }
            guard received >= 0 else { try fail("Cannot read command output") }
            if received == 0 { break }
            guard data.count + received <= 65_536 else { try fail("Command output limit exceeded") }
            data.append(contentsOf: chunk.prefix(received))
        }
        while waitpid(pid, &status, 0) < 0 { if errno != EINTR { try fail("Cannot wait for command") } }
    } catch {
        kill(pid, SIGTERM)
        throw error
    }
    let exitCode = status & 0x7f == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
    return ["exitCode": exitCode, "output": String(decoding: data, as: UTF8.self)]
}
func execute(_ root: Int32, _ writable: Bool, _ commands: Set<String>, _ input: [String: Any]) throws -> Any {
    if input["operation"] as? String == "command" { return try runCommand(root, commands, input) }
    guard let operation = input["operation"] as? String, let value = input["path"] as? String else { try fail("Invalid request") }
    let parts = try components(value, allowRoot: operation == "list")
    if operation == "list" {
        let fd = try directory(root, parts)
        guard let stream = fdopendir(fd) else { close(fd); try fail("Cannot list directory") }
        defer { closedir(stream) }
        var entries = [[String: Any]]()
        while let entry = readdir(stream) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            guard entries.count < 500 else { try fail("Directory exceeds listing limit") }
            var info = stat()
            _ = try check(fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW))
            let kind = info.st_mode & S_IFMT
            entries.append(["name": name, "kind": kind == S_IFDIR ? "directory" : kind == S_IFREG && info.st_nlink == 1 ? "file" : "blocked", "bytes": info.st_size])
        }
        return entries.sorted { ($0["name"] as! String) < ($1["name"] as! String) }
    }
    let parent = try directory(root, Array(parts.dropLast()))
    defer { close(parent) }
    let name = parts.last!
    if operation == "write" {
        guard writable, let encoded = input["data"] as? String, let data = Data(base64Encoded: encoded), data.count <= limit else { try fail("Write capability or data is invalid") }
        var old = stat()
        if fstatat(parent, name, &old, AT_SYMLINK_NOFOLLOW) == 0 {
            guard old.st_mode & S_IFMT == S_IFREG, old.st_nlink == 1 else { try fail("Destination is not a regular file") }
        } else if errno != ENOENT { try fail("Cannot inspect destination") }
        let temporary = ".mu-write-" + UUID().uuidString
        let fd = try check(openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600))
        defer { close(fd); unlinkat(parent, temporary, 0) }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < data.count {
                let count = write(fd, bytes.baseAddress!.advanced(by: offset), data.count - offset)
                guard count > 0 else { try fail("File write failed") }
                offset += count
            }
        }
        _ = try check(fsync(fd))
        _ = try check(renameat(parent, temporary, parent, name))
        return ["bytes": data.count]
    }
    guard ["read", "stat", "sha256"].contains(operation) else { try fail("Operation is not granted") }
    let (fd, info) = try regular(parent, name)
    defer { close(fd) }
    if operation == "stat" { return ["bytes": info.st_size, "modifiedAt": info.st_mtimespec.tv_sec] }
    let data = try readBytes(fd)
    if operation == "sha256" { return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    return ["data": data.base64EncodedString(), "bytes": data.count]
}
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}

var root: Int32 = -1, writable = false, commands = Set<String>()
while let line = readLine() {
    var id: Any = NSNull()
    do {
        guard line.utf8.count <= 1_500_000, let data = line.data(using: .utf8), let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("Invalid JSON request") }
        id = input["id"] ?? NSNull()
        if root < 0 {
            guard let absolute = input["root"] as? String, absolute.hasPrefix("/") else { try fail("Invalid root directory") }
            let parts = try components(String(absolute.dropFirst()))
            let start = try check(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC))
            defer { close(start) }
            root = try directory(start, parts)
            writable = input["writable"] as? Bool ?? false
            commands = Set(input["commands"] as? [String] ?? [])
            guard commands.isSubset(of: commandIds) else { try fail("Unknown command capability") }
            emit(["id": id, "ok": true, "result": ["ready": true]])
        } else { emit(["id": id, "ok": true, "result": try execute(root, writable, commands, input)]) }
    } catch BridgeError.denied(let message) { emit(["id": id, "ok": false, "error": message]) }
    catch { emit(["id": id, "ok": false, "error": "Invalid request"]) }
}
if root >= 0 { close(root) }
