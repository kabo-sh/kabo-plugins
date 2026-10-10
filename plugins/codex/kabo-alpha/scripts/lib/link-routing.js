// URL/media contract adapted from Web Agent PR120 (3786368). No network or credentials.
// Agent 只做纯 URL 路由；真实媒体类型来自现有数据接口，不自行请求跳转或供应商。
export function identifyPublicLink(input) {
    const result = {
        original_url: input,
        resolved_url: null,
        platform: "unknown",
        resource_kind: "unknown",
        resource_id: null,
        media_type_hint: "unknown",
        read: null,
    };
    let url;
    try {
        url = new URL(input);
    }
    catch {
        return result;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port)
        return result;
    const host = url.hostname.toLowerCase();
    const path = url.pathname.split("/").filter(Boolean);
    const route = (connector_id, operation, params) => {
        result.read = { connector_id, operation, params };
        // 标准地址没有做网络跳转；原始 query 留存，不把这格冒充短链已解析。
        if (result.resource_kind !== "share")
            result.resolved_url = url.href;
        return result;
    };
    const officialOrUnknown = () => {
        try {
            if (!isOfficialPage(url))
                throw new Error("unsupported_page");
            result.platform = "official_page";
            result.resource_kind = "page";
            return route("official-page-render", "render_page", { url: url.href });
        }
        catch {
            return result;
        }
    };
    if ([
        "tiktok.com",
        "www.tiktok.com",
        "m.tiktok.com",
        "vm.tiktok.com",
        "vt.tiktok.com",
    ].includes(host)) {
        result.platform = "tiktok";
        if (["vm.tiktok.com", "vt.tiktok.com"].includes(host) &&
            path.length === 1 &&
            /^[A-Za-z0-9_-]+$/.test(path[0])) {
            result.resource_kind = "share";
            return route("tiktok-search", "get_video", { url: url.href });
        }
        if (path.length === 3 &&
            /^@[A-Za-z0-9_][A-Za-z0-9_.]{0,23}$/.test(path[0]) &&
            ["video", "photo"].includes(path[1]) &&
            /^\d{1,32}$/.test(path[2])) {
            result.resource_kind = "post";
            result.resource_id = path[2];
            result.media_type_hint = path[1] === "photo" ? "image_carousel" : "video";
            return route("tiktok-search", "get_video", { url: url.href });
        }
        if (path.length === 1 &&
            /^@[A-Za-z0-9_][A-Za-z0-9_.]{0,23}$/.test(path[0])) {
            result.resource_kind = "account";
            result.resource_id = path[0].slice(1);
            return route("tiktok-discovery", "get_profile", {
                unique_id: result.resource_id,
            });
        }
        return officialOrUnknown();
    }
    if (["instagram.com", "www.instagram.com", "m.instagram.com"].includes(host)) {
        result.platform = "instagram";
        if (path.length === 2 &&
            ["p", "reel", "reels", "tv"].includes(path[0]) &&
            /^[A-Za-z0-9_-]+$/.test(path[1])) {
            result.resource_kind = "post";
            result.resource_id = path[1];
            result.media_type_hint = path[0] === "p" ? "unknown" : "video";
            return route("instagram-discovery", "get_post", { url: url.href });
        }
        if (path.length === 1 &&
            /^[A-Za-z0-9._]{1,30}$/.test(path[0]) &&
            ![
                "accounts",
                "explore",
                "direct",
                "stories",
                "reel",
                "reels",
                "p",
                "tv",
                "about",
                "legal",
            ].includes(path[0].toLowerCase())) {
            result.resource_kind = "account";
            result.resource_id = path[0];
            return route("instagram-discovery", "resolve_profile", {
                handle: result.resource_id,
            });
        }
        return officialOrUnknown();
    }
    if ([
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
    ].includes(host)) {
        result.platform = "youtube";
        const videoId = host === "youtu.be" && path.length === 1
            ? path[0]
            : path.length === 1 && path[0] === "watch"
                ? url.searchParams.get("v")
                : path.length === 2 && ["shorts", "embed", "live"].includes(path[0])
                    ? path[1]
                    : null;
        if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
            result.resource_kind = "post";
            result.resource_id = videoId;
            result.media_type_hint = "video";
            return route("youtube-public", "get_video", { video_id: videoId });
        }
        if ((path.length === 1 && /^@[A-Za-z0-9_.-]{1,63}$/.test(path[0])) ||
            (path.length === 2 &&
                path[0] === "channel" &&
                /^UC[A-Za-z0-9_-]{22}$/.test(path[1]))) {
            result.resource_kind = "account";
            result.resource_id = path.at(-1);
            return route("youtube-public", "get_channel", path[0] === "channel"
                ? { channel_id: result.resource_id }
                : { handle: result.resource_id });
        }
        return officialOrUnknown();
    }
    return officialOrUnknown();
}
// 只采信上游明确的媒体结构；轮播缺一项仍保留原位置，单张封面不当成整套图片。
export function instagramPostMedia(sourceUrl, raw) {
    const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
        ? v
        : {};
    const post = obj(raw);
    const kind = post.__typename;
    const type = kind === "GraphSidecar"
        ? "image_carousel"
        : kind === "GraphImage"
            ? "image"
            : kind === "GraphVideo"
                ? "video"
                : "unknown";
    const edge = obj(post.edge_sidecar_to_children);
    const items = type === "image_carousel" && Array.isArray(edge.edges)
        ? edge.edges.map((v) => obj(v).node)
        : type === "image"
            ? [post]
            : [];
    const slides = items.slice(0, 128).map((v, index) => {
        const node = obj(v);
        const url = typeof node.display_url === "string" && node.is_video !== true
            ? node.display_url
            : null;
        return {
            index: index + 1,
            media_url: url,
            fetch_status: url ? "available" : "missing",
        };
    });
    const captionEdges = obj(post.edge_media_to_caption).edges;
    const caption = Array.isArray(captionEdges)
        ? obj(obj(captionEdges[0]).node).text
        : null;
    const identity = identifyPublicLink(sourceUrl);
    return {
        original_url: sourceUrl,
        resolved_url: identity.resolved_url,
        post_id: typeof post.shortcode === "string"
            ? post.shortcode
            : identity.resource_id,
        media_type: type,
        caption: typeof caption === "string" ? caption : null,
        metrics: {
            likes: obj(post.edge_media_preview_like).count ?? null,
            comments: obj(post.edge_media_to_comment).count ?? null,
            views: post.video_view_count ?? null,
        },
        slides,
        returned_count: slides.length,
        expected_count: null,
        completeness: "unknown",
        video: type === "video" ? { source_url: sourceUrl } : null,
    };
}
function isOfficialPage(url) {
    const hosts = new Set([
        "support.tiktok.com", "newsroom.tiktok.com", "ads.tiktok.com",
        "help.instagram.com", "about.instagram.com", "creators.instagram.com",
        "support.google.com", "support.youtube.com", "blog.youtube", "www.blog.youtube",
        "blog.youtube.com", "legal.twitch.com", "help.twitch.tv",
    ]);
    if (hosts.has(url.hostname))
        return true;
    const path = url.pathname.toLowerCase().replace(/^\/[a-z]{2}(?:-[a-z0-9]+)?(?=\/)/, "");
    return url.hostname === "www.tiktok.com" && ["/community-guidelines", "/safety", "/support"].some(p => path === p || path.startsWith(p + "/"));
}
// 现有 tiktok-search/get_video 返回 data.video 原始帖子；名字不用于判断媒体类型。
export function tiktokPostMedia(sourceUrl, raw) {
    const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
    const post = obj(raw), author = obj(post.author), stats = obj(post.statistics);
    const id = typeof post.aweme_id === "string" && /^\d{1,32}$/.test(post.aweme_id) ? post.aweme_id : null;
    const privateFlag = (value) => value === true || value === 1 || value === "1";
    const isPrivate = (record) => [record.secret, record.is_private, record.privateAccount].some(privateFlag);
    const available = id !== null && !isPrivate(post) && !isPrivate(author) && !isPrivate(obj(post.status));
    const images = obj(post.image_post_info).images;
    const photo = available && (post.aweme_type === 150 || post.aweme_type === "150" || Array.isArray(images));
    const video = obj(post.video);
    const videoKnown = available && !photo && Object.keys(video).length > 0;
    const slides = photo && Array.isArray(images) ? images.slice(0, 128).map((value, index) => {
        const urls = obj(obj(value).display_image).url_list;
        const candidates = Array.isArray(urls) ? urls.filter((u) => typeof u === "string" && u.startsWith("https://")) : [];
        const media_url = candidates.find(u => /\.jpe?g(?:\?|$)/i.test(u)) ?? candidates[0] ?? null;
        return { index: index + 1, media_url, fetch_status: media_url ? "available" : "missing" };
    }) : [];
    const handle = typeof author.unique_id === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.]{0,23}$/.test(author.unique_id) ? author.unique_id : null;
    return {
        original_url: sourceUrl,
        resolved_url: available && handle ? `https://www.tiktok.com/@${handle}/${photo ? "photo" : "video"}/${id}` : null,
        post_id: available ? id : null,
        media_type: photo ? "image_carousel" : videoKnown ? "video" : "unknown",
        caption: available && typeof post.desc === "string" ? post.desc.slice(0, 10000) : null,
        metrics: available ? { views: stats.play_count ?? null, likes: stats.digg_count ?? null, comments: stats.comment_count ?? null } : null,
        slides, returned_count: slides.length, expected_count: null, completeness: "unknown", video: videoKnown ? video : null,
    };
}
