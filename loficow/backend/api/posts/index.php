<?php
$currentUser = optionalAuth();
$db = getDB();

$page  = max(1, (int)($_GET['page'] ?? 1));
$limit = min(20, max(1, (int)($_GET['limit'] ?? 10)));
$offset = ($page - 1) * $limit;
$type = $_GET['type'] ?? null;
$userId = $_GET['user_id'] ?? null;

$where = ['1=1'];
$params = [];

if ($type && in_array($type, ['track','wip','thought','collab_request'])) {
    $where[] = 'p.post_type = ?';
    $params[] = $type;
}
if ($userId) {
    $where[] = 'p.user_id = ?';
    $params[] = (int)$userId;
}

$whereStr = implode(' AND ', $where);
$likedJoin = $currentUser
    ? "LEFT JOIN post_likes pl2 ON pl2.post_id = p.id AND pl2.user_id = {$currentUser['id']}"
    : '';
$likedSelect = $currentUser ? ', IF(pl2.id IS NOT NULL, 1, 0) AS is_liked' : ', 0 AS is_liked';

$sql = "
    SELECT p.*,
           u.username, u.display_name, u.avatar_url, u.verified, u.account_type
           $likedSelect
    FROM posts p
    JOIN users u ON u.id = p.user_id
    $likedJoin
    WHERE $whereStr
    ORDER BY p.created_at DESC
    LIMIT $limit OFFSET $offset
";

$stmt = $db->prepare($sql);
$stmt->execute($params);
$posts = $stmt->fetchAll();

$countStmt = $db->prepare("SELECT COUNT(*) FROM posts p WHERE $whereStr");
$countStmt->execute($params);
$total = (int)$countStmt->fetchColumn();

json([
    'posts' => $posts,
    'meta'  => ['total' => $total, 'page' => $page, 'limit' => $limit, 'pages' => ceil($total / $limit)],
]);
