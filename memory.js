// ─── PRODUCER PROJECT MEMORY ─────────────────────────────
// Stores per-user project data in memory
// In production this would use a database

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return global.producerProjects[userId];
}

function deleteProject(userId) {
  delete global.producerProjects[userId];
}

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

module.exports = {
  getProject,
  saveProject,
  createProject,
  deleteProject,
  getActionPlan,
  saveActionPlan,
  completeTask,
  getSprintPlan,
  saveSprintPlan,
};
