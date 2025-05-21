import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/components/ui/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { Warning, QuizSettings } from '@/types';

export type MonitoringStudent = {
  id: string;
  name: string;
  email: string;
  progress: number;
  timeElapsed: number;
  warnings: Warning[];
  attemptId: string;
  answers: Record<string, number[]>;
  status: 'in_progress' | 'submitted';
  lastActive?: string;
};

export const useQuizMonitoring = (quizId: string | undefined) => {
  const [loading, setLoading] = useState(true);
  const [students, setStudents] = useState<MonitoringStudent[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [quizTitle, setQuizTitle] = useState('');
  const [timeLimit, setTimeLimit] = useState(30);
  const { toast } = useToast();
  const { user } = useAuth();
  
  // Function to fetch real-time student data
  const fetchStudentData = async () => {
    if (!quizId || !user) return;
    
    try {
      setLoading(true);
      console.log('Fetching monitoring data for quiz:', quizId);
      
      // Fetch quiz details
      const { data: quizData, error: quizError } = await supabase
        .from('quizzes')
        .select('title, settings, is_active')
        .eq('id', quizId)
        .single();
      
      if (quizError) {
        console.error('Error fetching quiz:', quizError);
        toast({
          variant: 'destructive',
          title: 'Failed to fetch quiz details',
          description: quizError.message
        });
        throw quizError;
      }
      
      if (!quizData) {
        console.error('Quiz not found');
        toast({
          variant: 'destructive',
          title: 'Quiz not found',
          description: 'The requested quiz could not be found'
        });
        setLoading(false);
        return;
      }
      
      console.log('Fetched quiz data:', quizData);
      setQuizTitle(quizData.title);
      
      // Type check and safely extract timeLimit from settings
      if (quizData.settings && typeof quizData.settings === 'object') {
        const settings = quizData.settings as unknown as QuizSettings;
        setTimeLimit(settings.timeLimit || 30);
      }
      
      // Count questions
      const { count, error: countError } = await supabase
        .from('questions')
        .select('*', { count: 'exact', head: true })
        .eq('quiz_id', quizId);
      
      if (countError) {
        console.error('Error counting questions:', countError);
        throw countError;
      }
      
      setTotalQuestions(count || 0);
      console.log('Total questions count:', count);
      
      // Calculate the activity threshold - consider students inactive if no activity in last 5 minutes
      const activityThreshold = new Date();
      activityThreshold.setMinutes(activityThreshold.getMinutes() - 5);
      const thresholdISO = activityThreshold.toISOString();
      
      // Fetch ONLY active attempts for this quiz - where submitted_at is null
      // AND monitoring_available is true
      const { data: attemptsData, error: attemptsError } = await supabase
        .from('quiz_attempts')
        .select(`
          id,
          student_id,
          started_at,
          submitted_at,
          answers,
          warnings,
          monitoring_available,
          updated_at
        `)
        .eq('quiz_id', quizId)
        .is('submitted_at', null)
        .eq('monitoring_available', true);
      
      if (attemptsError) {
        console.error('Error fetching attempts:', attemptsError);
        throw attemptsError;
      }
      
      // Log the number of potentially active attempts
      console.log('Fetched active attempts:', attemptsData?.length || 0, attemptsData);
      
      if (!attemptsData || attemptsData.length === 0) {
        console.log('No active students found');
        setStudents([]);
        setLoading(false);
        return;
      }
      
      // Get student profile information for found attempts
      const studentIds = attemptsData?.map(attempt => attempt.student_id) || [];
      
      if (studentIds.length === 0) {
        console.log('No active students found');
        setStudents([]);
        setLoading(false);
        return;
      }
      
      console.log('Fetching profiles for student IDs:', studentIds);
      
      const { data: studentsData, error: studentsError } = await supabase
        .from('profiles')
        .select('id, name')
        .in('id', studentIds);
      
      if (studentsError) {
        console.error('Error fetching student profiles:', studentsError);
        throw studentsError;
      }
      
      console.log('Fetched student profiles:', studentsData?.length || 0);
      
      // Map profiles to a lookup object
      const profileLookup = (studentsData || []).reduce((acc, profile) => {
        acc[profile.id] = profile;
        return acc;
      }, {} as Record<string, { id: string; name: string }>);
      
      // Format student data - each student with a non-null submitted_at is in progress
      const formattedStudents: MonitoringStudent[] = attemptsData.map(attempt => {
        const profile = profileLookup[attempt.student_id] || { id: attempt.student_id, name: 'Unknown Student' };
        
        // Calculate time elapsed
        const startTime = new Date(attempt.started_at).getTime();
        const timeElapsed = Math.round((Date.now() - startTime) / 1000);
        
        // Count progress based on number of answers
        const answers = attempt.answers as Record<string, number[]> || {};
        const progress = Object.keys(answers).length;
        
        // Parse warnings
        const warnings = Array.isArray(attempt.warnings) 
          ? attempt.warnings.map((w: any) => ({
              type: w.type || 'unknown',
              timestamp: w.timestamp || '',
              description: w.description || ''
            }))
          : [];
          
        return {
          id: attempt.student_id,
          name: profile.name,
          email: '', // Email removed due to potential permission issues
          progress,
          timeElapsed,
          warnings,
          attemptId: attempt.id,
          answers: answers,
          status: 'in_progress',
          lastActive: attempt.updated_at || attempt.started_at
        };
      });
      
      // Only display truly active attempts in the monitoring view
      // Students are considered active if they have monitoring_available = true
      // and their last update/activity was recent (within last few minutes)
      const activeStudents = formattedStudents;
      
      console.log('Formatted active students data:', activeStudents.length);
      setStudents(activeStudents);
    } catch (error: any) {
      console.error('Error fetching monitoring data:', error);
      toast({
        variant: 'destructive',
        title: 'Failed to fetch monitoring data',
        description: error.message || 'An error occurred'
      });
    } finally {
      setLoading(false);
    }
  };
  
  // Function to end quiz for a specific student
  const endQuizForStudent = async (studentId: string, attemptId: string) => {
    try {
      console.log(`Ending quiz for student ${studentId}, attempt ${attemptId}`);
      
      // Update the quiz attempt to mark it as submitted
      const { error } = await supabase
        .from('quiz_attempts')
        .update({
          submitted_at: new Date().toISOString(),
          auto_submitted: true
        })
        .eq('id', attemptId);
      
      if (error) {
        console.error('Error updating quiz attempt:', error);
        throw error;
      }
      
      toast({
        title: 'Quiz ended for student',
        description: 'The student\'s quiz has been submitted.'
      });
      
      // Update the local state by removing the student
      setStudents(prev => prev.filter(student => student.attemptId !== attemptId));
      
      return true;
    } catch (error: any) {
      console.error('Error ending quiz for student:', error);
      toast({
        variant: 'destructive',
        title: 'Failed to end quiz for student',
        description: error.message || 'An error occurred'
      });
      return false;
    }
  };
  
  // Function to end quiz for all students
  const endQuizForAll = async () => {
    if (!quizId || students.length === 0) return false;
    
    try {
      console.log(`Ending quiz ${quizId} for all students`);
      
      // Update all ongoing attempts for this quiz
      const { error } = await supabase
        .from('quiz_attempts')
        .update({
          submitted_at: new Date().toISOString(),
          auto_submitted: true
        })
        .eq('quiz_id', quizId)
        .is('submitted_at', null);
      
      if (error) {
        console.error('Error updating quiz attempts:', error);
        throw error;
      }
      
      console.log('Successfully ended all student attempts');
      
      // Also mark the quiz as inactive
      const { error: quizError } = await supabase
        .from('quizzes')
        .update({ is_active: false })
        .eq('id', quizId);
      
      if (quizError) {
        console.error('Error deactivating quiz:', quizError);
        throw quizError;
      }
      
      console.log('Successfully marked quiz as inactive');
      
      toast({
        title: 'Quiz ended for all students',
        description: 'All students\' quizzes have been submitted and the quiz has been deactivated.'
      });
      
      // Clear the students list
      setStudents([]);
      
      return true;
    } catch (error: any) {
      console.error('Error ending quiz for all:', error);
      toast({
        variant: 'destructive',
        title: 'Failed to end quiz',
        description: error.message || 'An error occurred'
      });
      return false;
    }
  };

  // Set up real-time subscription for quiz attempts
  useEffect(() => {
    if (!quizId) return;
    
    console.log('Setting up real-time subscription for quiz attempts');
    
    // Create a channel for quiz attempts
    const channel = supabase
      .channel('quiz-attempts-changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'quiz_attempts',
          filter: `quiz_id=eq.${quizId}`,
        },
        (payload) => {
          console.log('New quiz attempt detected:', payload);
          fetchStudentData();
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'quiz_attempts',
          filter: `quiz_id=eq.${quizId}`,
        },
        (payload) => {
          console.log('Quiz attempt updated:', payload);
          // If a student submitted or updated answers/warnings, refresh the data
          fetchStudentData();
        }
      )
      .subscribe(status => {
        console.log('Realtime subscription status:', status);
      });
    
    // Initial fetch
    fetchStudentData();
    
    return () => {
      console.log('Cleanup: removing real-time subscription');
      supabase.removeChannel(channel);
    };
  }, [quizId]);
  
  return {
    loading,
    students,
    totalQuestions,
    quizTitle,
    timeLimit,
    endQuizForStudent,
    endQuizForAll,
    refreshData: fetchStudentData
  };
};
