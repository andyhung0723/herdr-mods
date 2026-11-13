import Foundation

typealias MRGetInfo = @convention(c) (DispatchQueue, @escaping ([String: Any]) -> Void) -> Void
typealias MRGetClient = @convention(c) (DispatchQueue, @escaping (AnyObject?) -> Void) -> Void
typealias MRSendCommand = @convention(c) (Int32, AnyObject?) -> Bool

let handle = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW)
guard let handle = handle else {
    print("{}")
    exit(1)
}

let args = CommandLine.arguments

// Check if an action was requested
if args.contains("--toggle") {
    if let sym = dlsym(handle, "MRMediaRemoteSendCommand") {
        let fn = unsafeBitCast(sym, to: MRSendCommand.self)
        let ok = fn(2, nil) // 2: TogglePlayPause
        print("{\"ok\": \(ok)}")
        exit(0)
    }
    print("{\"ok\": false, \"error\": \"command_not_found\"}")
    exit(1)
}

var out: [String: Any] = [:]
let group = DispatchGroup()

if let sym = dlsym(handle, "MRMediaRemoteGetNowPlayingInfo") {
    let fn = unsafeBitCast(sym, to: MRGetInfo.self)
    group.enter()
    fn(DispatchQueue.main) { info in
        if let t = info["kMRMediaRemoteNowPlayingInfoTitle"] as? String { out["title"] = t }
        if let a = info["kMRMediaRemoteNowPlayingInfoArtist"] as? String { out["artist"] = a }
        if let album = info["kMRMediaRemoteNowPlayingInfoAlbum"] as? String { out["album"] = album }
        if let r = info["kMRMediaRemoteNowPlayingInfoPlaybackRate"] as? Double { out["playbackRate"] = r }
        group.leave()
    }
}

if let sym = dlsym(handle, "MRMediaRemoteGetNowPlayingClient") {
    let fn = unsafeBitCast(sym, to: MRGetClient.self)
    group.enter()
    fn(DispatchQueue.main) { client in
        if let c = client {
            out["client"] = String(describing: c)
        }
        group.leave()
    }
}

let deadline = Date(timeIntervalSinceNow: 0.6)
while Date() < deadline {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
    if out["title"] != nil && out["client"] != nil {
        break
    }
}

if let data = try? JSONSerialization.data(withJSONObject: out, options: []),
   let s = String(data: data, encoding: .utf8) {
    print(s)
} else {
    print("{}")
}
