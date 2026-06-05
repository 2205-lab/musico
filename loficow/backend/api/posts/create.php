<?php
$user = requireAuth();
$body = json_decode(file_get_contents('php://input'), true) ?? [];

$content    = trim($body['content'] ?? '');
$audioUrl   = $body['audio_url'] ?? null;
$coverUrl   = $body['cover_url'] ?? null;
$trackTitle = trim($body['track_title'] ?? '');
$trackBpm   = $body['track_bpm'] ? (int)$body['track_bpm'] : null;
$trackKey   = $body['track_key'] ?? null;
$trackDur   = $body['track_duration'] ? (int)$body['track_duration'] : null;
$postType   = $body['post_type'] ?? 'thought';
$tags       = $body['tags'] ?? null;

if (!$content && !$audioUrl) error('Post must have content or audio');
if (!in_array($postType, ['track','wip','thought','collab_request'])) error('Invalid post type');

$db = getDB();
$stmt = $db->prepare('
    INSERT INTO posts (user_id, content, audio_url, cover_url, track_title, track_bpm, track_key, track_duration, post_type, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
');
$stmt->execute([
    $user['id'], $content, $audioUrl, $coverUrl,
    $trackTitle ?: null, $trackBpm, $trackKey, $trackDur, $postType,
    is_array($tags) ? implode(',', $tags) : $tags,
]);
$postId = (int)$db->lastInsertId();

$db->prepare('UPDATE users SET tracks_count = tracks_count + 1 WHERE id = ?')->execute([$user['id']]);

$post = $db->query("
    SELECT p.*, u.username, u.display_name, u.avatar_url, u.verified, u.account_type, 0 AS is_liked
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.id = $postId
")->fetch();

json(['post' => $post], 201);
