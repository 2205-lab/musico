// ─── PRODUCER PROJECT MEMORY ─────────────────────────────
global.producerProjects = global.producerProjects || {};
global.actionPlans = global.actionPlans || {};
global.sprintPlans = global.sprintPlans || {};

function getProject(userId) {
  return global.producerProjects[userId] || null;
}

function saveProject(userId, data) {
  global.producerProjects[userId] = {
    ...global.producerProjects[userId],
    ...data,
    updatedAt: new Date().toISOString(),
  };
  return global.producerProjects[userId];
}

function createProject(userId, name) {
  global.producerProjects[userId] = {
    name,
    bpm: null,
    key: null,
    genre: null,
    references: [],
    feedbackHistory: [],
    decisions: [],
    tasks: [],
    completedTasks: [],
    deadline: null,
    artworkReady: false,
    metadataReady: false,
    distributionReady: false,
    mixAnalyzed: false,
    audioUploaded: false,
    arEvaluated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return global.producerProjects[userId];
}

function deleteProject(userId) {
  delete global.producerProjects[userId];
}

// ─── HEALTH SCORE ────────────────────────────────────────
function calculateHealthScore(userId) {
  const project = getProject(userId);
  if (!project) return null;

  const checks = {
    projectSetup: {
      name: { done: !!project.name, label: 'Project name defined' },
      bpm: { done: !!project.bpm, label: 'BPM defined' },
      key: { done: !!project.key, label: 'Key defined' },
      genre: { done: !!project.genre, label: 'Genre defined' },
    },
    productionPlanning: {
      sprint: { done: !!getSprintPlan(userId), label: 'Sprint created' },
      tasks: { done: project.tasks.length > 0, label: 'Tasks assigned' },
    },
    creativeDirection: {
      reference: { done: project.references.length > 0, label: 'Reference track selected' },
      arEvaluated: { done: project.arEvaluated, label: 'A&R evaluation done' },
    },
    audioDevelopment: {
      mixFeedback: { done: project.mixAnalyzed, label: 'Mix feedback completed' },
      audioUploaded: { done: project.audioUploaded, label: 'Audio analyzed' },
    },
    releaseReadiness: {
      artwork: { done: project.artworkReady, label: 'Artwork ready' },
      metadata: { done: project.metadataReady, label: 'Metadata ready' },
      distribution: { done: project.distributionReady, label: 'Distribution plan ready' },
      deadline: { done: !!project.deadline, label: 'Release deadline set' },
    },
  };

  let totalItems = 0;
  let completedItems = 0;
  const allChecks = [];

  for (const category of Object.keys(checks)) {
    for (const item of Object.keys(checks[category])) {
      totalItems++;
      const check = checks[category][item];
      if (check.done) completedItems++;
      allChecks.push(check);
    }
  }

  const score = Math.round((completedItems / totalItems) * 100);

  return {
    score,
    completedItems,
    totalItems,
    checks,
    allChecks,
  };
}

// ─── ACTION PLAN ─────────────────────────────────────────
function getActionPlan(userId) {
  return global.actionPlans[userId] || null;
}

function saveActionPlan(userId, plan) {
  global.actionPlans[userId] = {
    items: plan,
    completed: [],
    createdAt: new Date().toISOString(),
  };
  return global.actionPlans[userId];
}

function completeTask(userId, taskIndex) {
  const plan = global.actionPlans[userId];
  if (!plan) return null;
  if (!plan.completed.includes(taskIndex)) {
    plan.completed.push(taskIndex);
  }
  return plan;
}

// ─── SPRINT PLAN ─────────────────────────────────────────
function getSprintPlan(userId) {
  return global.sprintPlans[userId] || null;
}

function saveSprintPlan(userId, plan) {
  global.sprintPlans[userId] = {
    ...plan,
    completed: [],
    createdAt: new Date().toISOString(),
  };
  return global.sprintPlans[userId];
}

function completeSprintTask(userId, taskIndex) {
  const plan = global.sprintPlans[userId];
  if (!plan) return null;
  if (!plan.completed.includes(taskIndex)) {
    plan.completed.push(taskIndex);
  }
  return plan;
}

module.exports = {
  getProject,
  saveProject,
  createProject,
  deleteProject,
  calculateHealthScore,
  getActionPlan,
  saveActionPlan,
  completeTask,
  getSprintPlan,
  saveSprintPlan,
  completeSprintTask,
};
