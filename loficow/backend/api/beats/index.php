<?php
$currentUser = optionalAuth();
$db = getDB();

$page   = max(1, (int)($_GET['page'] ?? 1));
$limit  = min(20, max(1, (int)($_GET['limit'] ?? 12)));
$offset = ($page - 1) * $limit;
$genre  = $_GET['genre'] ?? null;
$mood   = $_GET['mood'] ?? null;
$free   = isset($_GET['free']) ? 1 : null;
$userId = $_GET['user_id'] ?? null;
$sort   = $_GET['sort'] ?? 'newest';

$where  = ['1=1'];
$params = [];

if ($genre)  { $where[] = 'b.genre = ?';    $params[] = $genre; }
if ($mood)   { $where[] = 'b.mood = ?';     $params[] = $mood; }
if ($free !== null) { $where[] = 'b.is_free = ?'; $params[] = $free; }
if ($userId) { $where[] = 'b.user_id = ?';  $params[] = (int)$userId; }

$whereStr = implode(' AND ', $where);
$orderBy = match($sort) {
    'popular' => 'b.plays_count DESC',
    'likes'   => 'b.likes_count DESC',
    default   => 'b.created_at DESC',
};

$stmt = $db->prepare("
    SELECT b.*, u.username, u.display_name, u.avatar_url, u.verified
    FROM beats b JOIN users u ON u.id = b.user_id
    WHERE $whereStr
    ORDER BY $orderBy
    LIMIT $limit OFFSET $offset
");
$stmt->execute($params);
$beats = $stmt->fetchAll();

$countStmt = $db->prepare("SELECT COUNT(*) FROM beats b WHERE $whereStr");
$countStmt->execute($params);
$total = (int)$countStmt->fetchColumn();

json(['beats' => $beats, 'meta' => ['total' => $total, 'page' => $page, 'pages' => ceil($total / $limit)]]);
